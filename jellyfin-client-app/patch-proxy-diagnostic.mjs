import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('ODIN_PROXY_DIAG_RESULT')) {
  const marker = "setTimeout(() => void cleanupAbandoned().catch((e) => console.error('cleanup:', e.message)), 20_000).unref?.();";
  if (!source.includes(marker)) throw new Error('Proxy diagnostic patch failed: timer marker');

  const runner = `
if (process.env.DIAG_PROXY === '1') {
  setTimeout(async () => {
    const username = String(process.env.DIAG_USER || '').trim();
    const password = String(process.env.DIAG_PASS || '');
    const upstreamBase = String(process.env.DIAG_BASE || '').replace(/\\/$/, '');
    const publicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
    const result = { direct: {}, proxy: {}, manifest: {}, comparison: {} };
    const tempId = secret(6);
    const tempProfile = {
      id: tempId,
      name: 'Temporary Odin Catalog Test',
      setupKey: secret(24),
      bridgeKey: secret(24),
      createdAt: new Date().toISOString(),
    };

    async function diagGet(baseUrl, path, token = '') {
      const r = await fetch(jfUrl(baseUrl, path), {
        headers: token ? jfHeaders(token) : { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      return { status: r.status, body, text: text.slice(0, 160) };
    }

    async function inspectViews(baseUrl, auth) {
      const r = await diagGet(baseUrl, \`/Users/\${encodeURIComponent(auth.userId)}/Views\`, auth.token);
      const views = Array.isArray(r.body?.Items) ? r.body.Items : [];
      const rows = [];
      for (const view of views) {
        const q = \`/Users/\${encodeURIComponent(auth.userId)}/Items?ParentId=\${encodeURIComponent(view.Id)}&Recursive=true&Limit=1\`;
        const ir = await diagGet(baseUrl, q, auth.token);
        rows.push({
          key: \`\${String(view.Name || '')}::\${String(view.CollectionType || '')}\`,
          name: String(view.Name || ''),
          collectionType: String(view.CollectionType || ''),
          status: ir.status,
          totalRecordCount: Number(ir.body?.TotalRecordCount || 0),
        });
      }
      return { status: r.status, count: views.length, views: rows };
    }

    try {
      if (!username || !password || !upstreamBase) throw new Error('diagnostic environment incomplete');
      const directAuth = await loginJellyfin(upstreamBase, username, password);
      result.direct.authStatus = 200;
      result.direct.views = await inspectViews(upstreamBase, directAuth);
      const directSys = await diagGet(upstreamBase, '/System/Info/Public', directAuth.token);
      result.direct.systemInfo = {
        status: directSys.status,
        serverName: String(directSys.body?.ServerName || ''),
        version: String(directSys.body?.Version || ''),
      };

      await saveProfile(tempProfile);
      await redis.set(jfKey(tempId), JSON.stringify({
        baseUrl: upstreamBase,
        username,
        token: directAuth.token,
        userId: directAuth.userId,
        name: directAuth.name,
      }));

      const publicBase = publicDomain ? \`https://\${publicDomain}\` : \`http://127.0.0.1:\${Math.max(1, PORT - 1)}\`;
      const proxyBase = \`\${publicBase}/j/\${tempId}/\${encodeURIComponent(tempProfile.bridgeKey)}\`;
      const proxyAuth = await loginJellyfin(proxyBase, username, password);
      result.proxy.authStatus = 200;
      result.proxy.views = await inspectViews(proxyBase, proxyAuth);
      const proxySys = await diagGet(proxyBase, '/System/Info/Public', proxyAuth.token);
      result.proxy.systemInfo = {
        status: proxySys.status,
        serverName: String(proxySys.body?.ServerName || ''),
        version: String(proxySys.body?.Version || ''),
        localAddressRewritten: proxySys.body?.LocalAddress ? String(proxySys.body.LocalAddress).startsWith(proxyBase) : null,
        wanAddressRewritten: proxySys.body?.WanAddress ? String(proxySys.body.WanAddress).startsWith(proxyBase) : null,
      };

      const manifestUrl = \`\${publicBase}/u/\${tempId}/\${encodeURIComponent(tempProfile.bridgeKey)}/manifest.json\`;
      const mr = await fetch(manifestUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      const mj = await mr.json().catch(() => null);
      result.manifest = {
        status: mr.status,
        watchStateVersion: mj?.watchState?.version ?? null,
        playbackVersion: mj?.playback?.version ?? null,
        pushEvents: Array.isArray(mj?.watchState?.push?.events) ? mj.watchState.push.events : [],
      };

      const d = result.direct.views?.views || [];
      const p = result.proxy.views?.views || [];
      const pByKey = new Map(p.map((x) => [x.key, x]));
      const mismatches = [];
      for (const row of d) {
        const other = pByKey.get(row.key);
        if (!other) mismatches.push({ name: row.name, collectionType: row.collectionType, issue: 'missing in proxy' });
        else if (row.totalRecordCount !== other.totalRecordCount) {
          mismatches.push({ name: row.name, collectionType: row.collectionType, direct: row.totalRecordCount, proxy: other.totalRecordCount });
        }
      }
      for (const row of p) {
        if (!d.some((x) => x.key === row.key)) mismatches.push({ name: row.name, collectionType: row.collectionType, issue: 'extra in proxy' });
      }
      result.comparison = {
        directViewCount: result.direct.views?.count ?? null,
        proxyViewCount: result.proxy.views?.count ?? null,
        exactCatalogMatch: result.direct.views?.count === result.proxy.views?.count && mismatches.length === 0,
        mismatches,
      };

      // Remove internal comparison keys from logged rows.
      for (const row of result.direct.views?.views || []) delete row.key;
      for (const row of result.proxy.views?.views || []) delete row.key;
    } catch (e) {
      result.fatal = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 500);
    } finally {
      await redis.del([
        profileKey(tempId), jfKey(tempId), tokenKey(tempId), deviceKey(tempId), pullKey(tempId),
        watchedKey(tempId), resumeKey(tempId), statusKey(tempId), lockKey(tempId), droppedKey(tempId),
      ]).catch(() => undefined);
      await redis.sRem('jc:profiles', tempId).catch(() => undefined);
      console.log('ODIN_PROXY_DIAG_RESULT', JSON.stringify(result));
    }
  }, 8000).unref?.();
}
`;

  source = source.replace(marker, `${runner}\n${marker}`);
}

await writeFile(file, source, 'utf8');
console.log('Applied temporary Odin proxy catalog comparison');
