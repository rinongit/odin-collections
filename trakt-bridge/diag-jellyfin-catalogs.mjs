import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const username = String(process.env.DIAG_USER || '').trim();
const password = String(process.env.DIAG_PASS || '');

const result = { attemptedServers: 0, matches: [], errors: [] };

function authHeader(token = '') {
  const p = [
    'MediaBrowser Client="Odin Catalog Diagnostic"',
    'Device="Railway"',
    'DeviceId="odin-catalog-diagnostic"',
    'Version="1.0"',
  ];
  if (token) p.push(`Token="${token}"`);
  return p.join(', ');
}

function jfUrl(base, path) {
  return `${String(base || '').replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function jfHeaders(token) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'OdinCatalogDiagnostic/1.0',
    'x-emby-token': token,
    'x-mediabrowser-token': token,
    'x-emby-authorization': authHeader(token),
  };
}

async function login(baseUrl) {
  const r = await fetch(jfUrl(baseUrl, '/Users/AuthenticateByName'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'OdinCatalogDiagnostic/1.0',
      'x-emby-authorization': authHeader(),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
  const j = JSON.parse(text);
  if (!j?.AccessToken || !j?.User?.Id) throw new Error('login response missing token/user id');
  return { token: j.AccessToken, userId: j.User.Id, name: String(j.User?.Name || '') };
}

async function getJson(baseUrl, path, token) {
  const r = await fetch(jfUrl(baseUrl, path), {
    headers: jfHeaders(token),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, body, text: text.slice(0, 120) };
}

async function inspectServer(baseUrl, source) {
  result.attemptedServers++;
  let host = '';
  try { host = new URL(baseUrl).host; } catch {}
  try {
    const auth = await login(baseUrl);
    const viewsRes = await getJson(baseUrl, `/Users/${encodeURIComponent(auth.userId)}/Views`, auth.token);
    const views = Array.isArray(viewsRes.body?.Items) ? viewsRes.body.Items : [];
    const rows = [];
    for (const view of views) {
      const itemsRes = await getJson(
        baseUrl,
        `/Users/${encodeURIComponent(auth.userId)}/Items?ParentId=${encodeURIComponent(view.Id)}&Recursive=true&Limit=1`,
        auth.token,
      );
      rows.push({
        name: String(view.Name || ''),
        collectionType: String(view.CollectionType || ''),
        itemStatus: itemsRes.status,
        totalRecordCount: Number(itemsRes.body?.TotalRecordCount || 0),
      });
    }
    const sys = await getJson(baseUrl, '/System/Info/Public', auth.token);
    result.matches.push({
      source,
      host,
      authStatus: 200,
      jellyfinUserName: auth.name,
      viewsStatus: viewsRes.status,
      viewCount: views.length,
      views: rows,
      systemInfo: {
        status: sys.status,
        serverName: String(sys.body?.ServerName || ''),
        version: String(sys.body?.Version || ''),
      },
    });
    return true;
  } catch (e) {
    result.errors.push({ source, host, error: String(e?.message || e).replace(password, '[REDACTED]').slice(0, 180) });
    return false;
  }
}

if (process.env.DIAG_OLD === '1') {
  let redis;
  try {
    if (!REDIS_URL || !username || !password) throw new Error('diagnostic environment incomplete');
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => undefined);
    await redis.connect();

    const candidates = [];
    const directRaw = await redis.get('jellyfin:direct:config:v1');
    try {
      const cfg = directRaw ? JSON.parse(directRaw) : null;
      if (cfg?.baseUrl) candidates.push({ source: 'direct-owner', baseUrl: cfg.baseUrl });
    } catch {}

    const profileIds = await redis.sMembers('mu:profiles');
    for (const id of profileIds) {
      if (!/^[a-f0-9]{12}$/.test(String(id))) continue;
      const raw = await redis.get(`mu:jf:${id}`);
      try {
        const cfg = raw ? JSON.parse(raw) : null;
        if (cfg?.baseUrl) candidates.push({ source: `multiuser:${id.slice(0,4)}…${id.slice(-4)}`, baseUrl: cfg.baseUrl });
      } catch {}
    }

    const unique = new Map();
    for (const c of candidates) if (!unique.has(c.baseUrl)) unique.set(c.baseUrl, c);
    for (const c of unique.values()) await inspectServer(c.baseUrl, c.source);
  } catch (e) {
    result.fatal = String(e?.message || e).replace(password, '[REDACTED]').slice(0, 300);
  } finally {
    if (redis?.isOpen) await redis.quit().catch(() => undefined);
  }
  console.log('OLD_JELLYFIN_DIAG_RESULT', JSON.stringify(result));
}
