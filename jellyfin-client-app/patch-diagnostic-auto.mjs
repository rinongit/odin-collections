import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('CATALOG_DIAG_RESULT')) {
  const marker = "setTimeout(() => void cleanupAbandoned().catch((e) => console.error('cleanup:', e.message)), 20_000).unref?.();";
  if (!source.includes(marker)) throw new Error('Diagnostic auto patch failed: timer marker');

  const runner = `
if (process.env.DIAG_AUTO === '1') {
  setTimeout(async () => {
    const username = String(process.env.DIAG_USER || '').trim();
    const password = String(process.env.DIAG_PASS || '');
    const publicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
    const result = { direct: {}, proxy: {}, manifest: {}, comparison: {} };
    try {
      if (!username || !password || !publicDomain) throw new Error('diagnostic environment incomplete');
      const ids = (await redis.sMembers('jc:profiles')).filter(safeId);
      let match = null;
      for (const id of ids) {
        const cfg = await getJf(id);
        if (cfg?.username === username) {
          const profile = await getProfile(id);
          if (profile?.bridgeKey && cfg?.baseUrl) { match = { id, cfg, profile }; break; }
        }
      }
      if (!match) throw new Error('matching configured profile not found');

      result.profile = \`\${match.id.slice(0, 4)}…\${match.id.slice(-4)}\`;
      try { result.upstreamHost = new URL(match.cfg.baseUrl).host; } catch { result.upstreamHost = ''; }
      const proxyBase = \`https://\${publicDomain}/j/\${match.id}/\${encodeURIComponent(match.profile.bridgeKey)}\`;
      const manifestUrl = \`https://\${publicDomain}/u/\${match.id}/\${encodeURIComponent(match.profile.bridgeKey)}/manifest.json\`;

      try {
        const auth = await loginJellyfin(match.cfg.baseUrl, username, password);
        result.direct.authStatus = 200;
        result.direct.views = await diagViews(match.cfg.baseUrl, auth.userId, auth.token);
        const sys = await diagJson(match.cfg.baseUrl, '/System/Info/Public', auth.token);
        result.direct.systemInfo = {
          status: sys.status,
          serverName: String(sys.body?.ServerName || ''),
          localAddress: String(sys.body?.LocalAddress || ''),
          wanAddress: String(sys.body?.WanAddress || ''),
        };
      } catch (e) {
        result.direct.authStatus = 500;
        result.direct.error = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 300);
      }

      try {
        const auth = await loginJellyfin(proxyBase, username, password);
        result.proxy.authStatus = 200;
        result.proxy.views = await diagViews(proxyBase, auth.userId, auth.token);
        const sys = await diagJson(proxyBase, '/System/Info/Public', auth.token);
        result.proxy.systemInfo = {
          status: sys.status,
          serverName: String(sys.body?.ServerName || ''),
          localAddress: String(sys.body?.LocalAddress || ''),
          wanAddress: String(sys.body?.WanAddress || ''),
        };
      } catch (e) {
        result.proxy.authStatus = 500;
        result.proxy.error = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 300);
      }

      try {
        const r = await fetch(manifestUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        const j = await r.json().catch(() => null);
        result.manifest = {
          status: r.status,
          watchStateVersion: j?.watchState?.version ?? null,
          playbackVersion: j?.playback?.version ?? null,
          pushEvents: Array.isArray(j?.watchState?.push?.events) ? j.watchState.push.events : [],
        };
      } catch (e) {
        result.manifest = { status: 0, error: String(e?.message || e).slice(0, 200) };
      }

      const directViews = result.direct.views?.views || [];
      const proxyViews = result.proxy.views?.views || [];
      const proxyByName = new Map(proxyViews.map((v) => [v.name, v]));
      const mismatches = [];
      for (const d of directViews) {
        const p = proxyByName.get(d.name);
        if (!p) mismatches.push({ name: d.name, issue: 'missing in proxy' });
        else if (d.totalRecordCount !== p.totalRecordCount) mismatches.push({ name: d.name, direct: d.totalRecordCount, proxy: p.totalRecordCount });
      }
      for (const p of proxyViews) {
        if (!directViews.some((d) => d.name === p.name)) mismatches.push({ name: p.name, issue: 'extra in proxy' });
      }
      result.comparison = {
        directViewCount: result.direct.views?.count ?? null,
        proxyViewCount: result.proxy.views?.count ?? null,
        exactCatalogMatch: result.direct.views?.count === result.proxy.views?.count && mismatches.length === 0,
        mismatches,
        proxyAddressesRewritten: Boolean(result.proxy.systemInfo?.localAddress || result.proxy.systemInfo?.wanAddress)
          ? [result.proxy.systemInfo?.localAddress, result.proxy.systemInfo?.wanAddress]
              .filter(Boolean)
              .every((v) => String(v).startsWith(proxyBase))
          : null,
      };
    } catch (e) {
      result.fatal = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 400);
    }
    console.log('CATALOG_DIAG_RESULT', JSON.stringify(result));
  }, 5000).unref?.();
}
`;

  source = source.replace(marker, `${runner}\n${marker}`);
}

await writeFile(file, source, 'utf8');
console.log('Applied temporary internal catalog diagnostic runner');
