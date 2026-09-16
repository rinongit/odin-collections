import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('async function runCatalogDiagnostic(req, res)')) {
  const helper = `
async function diagJson(baseUrl, path, token = '') {
  const r = await fetch(jfUrl(baseUrl, path), {
    headers: token ? jfHeaders(token) : { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, ok: r.ok, body, text: text.slice(0, 300) };
}

async function diagViews(baseUrl, userId, token) {
  const viewsRes = await diagJson(baseUrl, \`/Users/\${encodeURIComponent(userId)}/Views\`, token);
  const views = Array.isArray(viewsRes.body?.Items) ? viewsRes.body.Items : [];
  const rows = [];
  for (const view of views) {
    const path = \`/Users/\${encodeURIComponent(userId)}/Items?ParentId=\${encodeURIComponent(view.Id)}&Recursive=true&Limit=1\`;
    const itemRes = await diagJson(baseUrl, path, token);
    rows.push({
      name: String(view.Name || ''),
      type: String(view.CollectionType || view.Type || ''),
      itemStatus: itemRes.status,
      totalRecordCount: Number(itemRes.body?.TotalRecordCount || 0),
    });
  }
  return { status: viewsRes.status, count: views.length, views: rows };
}

async function runCatalogDiagnostic(req, res) {
  const diagKey = String(process.env.DIAG_KEY || '');
  if (!diagKey || !secureEq(req.headers['x-diag-key'], diagKey)) {
    return sendJson(res, 404, { error: 'not found' });
  }

  let input;
  try { input = JSON.parse(await readBody(req)); }
  catch { return sendJson(res, 400, { error: 'invalid json' }); }

  const username = String(input?.username || '').trim();
  const password = String(input?.password || '');
  if (!username || !password) return sendJson(res, 400, { error: 'username and password required' });

  const ids = (await redis.sMembers('jc:profiles')).filter(safeId);
  let match = null;
  for (const id of ids) {
    const cfg = await getJf(id);
    if (cfg?.username === username) {
      const profile = await getProfile(id);
      if (profile?.bridgeKey && cfg?.baseUrl) {
        match = { id, cfg, profile };
        break;
      }
    }
  }
  if (!match) return sendJson(res, 404, { error: 'matching configured profile not found' });

  const upstreamHost = (() => {
    try { return new URL(match.cfg.baseUrl).host; } catch { return ''; }
  })();
  const proxyBase = \`\${origin(req)}/j/\${match.id}/\${encodeURIComponent(match.profile.bridgeKey)}\`;
  const manifestUrl = \`\${origin(req)}/u/\${match.id}/\${encodeURIComponent(match.profile.bridgeKey)}/manifest.json\`;

  const out = {
    profile: \`\${match.id.slice(0, 4)}…\${match.id.slice(-4)}\`,
    upstreamHost,
    direct: {},
    proxy: {},
    comparison: {},
    manifest: {},
  };

  try {
    const auth = await loginJellyfin(match.cfg.baseUrl, username, password);
    out.direct.authStatus = 200;
    out.direct.views = await diagViews(match.cfg.baseUrl, auth.userId, auth.token);
    const sys = await diagJson(match.cfg.baseUrl, '/System/Info/Public', auth.token);
    out.direct.systemInfo = {
      status: sys.status,
      serverName: String(sys.body?.ServerName || ''),
      localAddress: String(sys.body?.LocalAddress || ''),
      wanAddress: String(sys.body?.WanAddress || ''),
    };
  } catch (e) {
    out.direct.authStatus = Number(e?.status || 0) || 500;
    out.direct.error = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 300);
  }

  try {
    const auth = await loginJellyfin(proxyBase, username, password);
    out.proxy.authStatus = 200;
    out.proxy.views = await diagViews(proxyBase, auth.userId, auth.token);
    const sys = await diagJson(proxyBase, '/System/Info/Public', auth.token);
    out.proxy.systemInfo = {
      status: sys.status,
      serverName: String(sys.body?.ServerName || ''),
      localAddress: String(sys.body?.LocalAddress || ''),
      wanAddress: String(sys.body?.WanAddress || ''),
    };
  } catch (e) {
    out.proxy.authStatus = Number(e?.status || 0) || 500;
    out.proxy.error = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 300);
  }

  try {
    const r = await fetch(manifestUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => null);
    out.manifest = {
      status: r.status,
      watchStateVersion: j?.watchState?.version ?? null,
      playbackVersion: j?.playback?.version ?? null,
      pushEvents: Array.isArray(j?.watchState?.push?.events) ? j.watchState.push.events : [],
    };
  } catch (e) {
    out.manifest = { status: 0, error: String(e?.message || e).slice(0, 200) };
  }

  const directViews = out.direct.views?.views || [];
  const proxyViews = out.proxy.views?.views || [];
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
  out.comparison = {
    viewCountEqual: out.direct.views?.count === out.proxy.views?.count,
    directViewCount: out.direct.views?.count ?? null,
    proxyViewCount: out.proxy.views?.count ?? null,
    mismatches,
    exactCatalogMatch: out.direct.views?.count === out.proxy.views?.count && mismatches.length === 0,
    proxyAddressesRewritten: Boolean(out.proxy.systemInfo?.localAddress || out.proxy.systemInfo?.wanAddress)
      ? [out.proxy.systemInfo?.localAddress, out.proxy.systemInfo?.wanAddress]
          .filter(Boolean)
          .every((v) => String(v).startsWith(proxyBase))
      : null,
  };

  return sendJson(res, 200, out);
}
`;

  const marker = 'async function handle(req, res) {';
  if (!source.includes(marker)) throw new Error('Diagnostic patch failed: handle marker');
  source = source.replace(marker, `${helper}\n${marker}`);

  const routeAnchor = "  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);\n\n  if (await handleJellyfinProxy(req, res, u)) return;";
  const routeReplacement = "  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);\n\n  if (u.pathname === '/__diag/catalog-test' && req.method === 'POST') {\n    await runCatalogDiagnostic(req, res);\n    return;\n  }\n\n  if (await handleJellyfinProxy(req, res, u)) return;";
  if (!source.includes(routeAnchor)) throw new Error('Diagnostic patch failed: route anchor');
  source = source.replace(routeAnchor, routeReplacement);
}

await writeFile(file, source, 'utf8');
console.log('Applied temporary catalog diagnostic endpoint');
