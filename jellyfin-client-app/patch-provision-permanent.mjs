import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('PERMANENT_PROFILE_PROVISION_RESULT')) {
  const marker = "setTimeout(() => void cleanupAbandoned().catch((e) => console.error('cleanup:', e.message)), 20_000).unref?.();";
  if (!source.includes(marker)) throw new Error('Provision patch failed: timer marker');

  const runner = `
if (process.env.PROVISION_PERM === '1') {
  setTimeout(async () => {
    const username = String(process.env.PROVISION_USER || '').trim();
    const password = String(process.env.PROVISION_PASS || '');
    const id = String(process.env.PROVISION_ID || '').trim();
    const bridgeKey = String(process.env.PROVISION_BRIDGE_KEY || '').trim();
    const setupKey = String(process.env.PROVISION_SETUP_KEY || '').trim();
    const result = {
      profileId: id ? \`\${id.slice(0,4)}…\${id.slice(-4)}\` : '',
      jellyfinConnected: false,
      catalogCount: null,
      proxyCatalogCount: null,
      exactCatalogMatch: false,
      traktMigrated: false,
      traktConnected: false,
      manifestWatchStateVersion: null,
      manifestPlaybackVersion: null,
    };
    try {
      if (!username || !password || !/^[a-f0-9]{12}$/.test(id) || !bridgeKey || !setupKey) {
        throw new Error('provision environment incomplete');
      }

      const oldRaw = await redis.get('jellyfin:direct:config:v1');
      let oldCfg = null;
      try { oldCfg = oldRaw ? JSON.parse(oldRaw) : null; } catch {}
      const baseUrl = String(oldCfg?.baseUrl || '').replace(/\\/$/, '');
      if (!baseUrl) throw new Error('stored AIOStreams Jellyfin URL not found');

      const auth = await loginJellyfin(baseUrl, username, password);
      const profile = {
        id,
        name: 'Rinon AIOStreams',
        setupKey,
        bridgeKey,
        createdAt: new Date().toISOString(),
      };
      await saveProfile(profile);
      await redis.set(jfKey(id), JSON.stringify({
        baseUrl,
        username,
        token: auth.token,
        userId: auth.userId,
        name: auth.name,
      }));
      result.jellyfinConnected = true;

      // Migrate the existing owner's Trakt app credentials/tokens when the
      // new app exposes the corresponding per-profile key helpers.
      const [oldClientId, oldClientSecret, oldTokens] = await redis.mGet([
        'trakt:client_id', 'trakt:client_secret', 'trakt:tokens'
      ]);
      let credsCopied = false;
      let tokensCopied = false;
      if (oldClientId && oldClientSecret) {
        if (typeof credsKey === 'function') {
          await redis.set(credsKey(id), JSON.stringify({ clientId: oldClientId, clientSecret: oldClientSecret }));
          credsCopied = true;
        } else if (typeof appCredsKey === 'function') {
          await redis.set(appCredsKey(id), JSON.stringify({ clientId: oldClientId, clientSecret: oldClientSecret }));
          credsCopied = true;
        }
      }
      if (oldTokens && typeof tokenKey === 'function') {
        await redis.set(tokenKey(id), oldTokens);
        tokensCopied = true;
      }
      result.traktMigrated = credsCopied && tokensCopied;

      const directViewsRes = await fetch(jfUrl(baseUrl, \`/Users/\${encodeURIComponent(auth.userId)}/Views\`), {
        headers: jfHeaders(auth.token), signal: AbortSignal.timeout(30_000),
      });
      const directViews = await directViewsRes.json();
      const directRows = Array.isArray(directViews?.Items) ? directViews.Items : [];
      result.catalogCount = directRows.length;

      const publicBase = \`https://\${String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim()}\`;
      const proxyBase = \`\${publicBase}/j/\${id}/\${encodeURIComponent(bridgeKey)}\`;
      const proxyAuth = await loginJellyfin(proxyBase, username, password);
      const proxyViewsRes = await fetch(jfUrl(proxyBase, \`/Users/\${encodeURIComponent(proxyAuth.userId)}/Views\`), {
        headers: jfHeaders(proxyAuth.token), signal: AbortSignal.timeout(30_000),
      });
      const proxyViews = await proxyViewsRes.json();
      const proxyRows = Array.isArray(proxyViews?.Items) ? proxyViews.Items : [];
      result.proxyCatalogCount = proxyRows.length;
      const directKeys = directRows.map((x) => \`\${x.Name || ''}::\${x.CollectionType || ''}\`).sort();
      const proxyKeys = proxyRows.map((x) => \`\${x.Name || ''}::\${x.CollectionType || ''}\`).sort();
      result.exactCatalogMatch = JSON.stringify(directKeys) === JSON.stringify(proxyKeys);

      const manifestUrl = \`\${publicBase}/u/\${id}/\${encodeURIComponent(bridgeKey)}/manifest.json\`;
      const mr = await fetch(manifestUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      const mj = await mr.json().catch(() => null);
      result.manifestWatchStateVersion = mj?.watchState?.version ?? null;
      result.manifestPlaybackVersion = mj?.playback?.version ?? null;

      if (result.traktMigrated && typeof traktFetch === 'function') {
        try {
          const tr = await traktFetch(id, '/users/settings');
          result.traktConnected = tr.ok;
          await tr.text().catch(() => '');
        } catch {
          result.traktConnected = false;
        }
      }

      if (typeof pullKey === 'function') await redis.del(pullKey(id)).catch(() => undefined);
      if (typeof droppedKey === 'function') await redis.del(droppedKey(id)).catch(() => undefined);
    } catch (e) {
      result.error = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 400);
    }
    console.log('PERMANENT_PROFILE_PROVISION_RESULT', JSON.stringify(result));
  }, 7000).unref?.();
}
`;

  source = source.replace(marker, `${runner}\n${marker}`);
}

await writeFile(file, source, 'utf8');
console.log('Applied one-time permanent profile provisioner');
