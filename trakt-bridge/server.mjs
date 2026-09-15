import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createClient } from 'redis';

const PORT = Number(process.env.PORT || 10000);
const REDIS_URL = process.env.REDIS_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const BRIDGE_KEY = process.env.BRIDGE_KEY;

if (!REDIS_URL || !ADMIN_KEY || !BRIDGE_KEY) {
  console.error('Missing REDIS_URL, ADMIN_KEY or BRIDGE_KEY');
  process.exit(1);
}

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err.message));
await redis.connect();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const html = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const redirect = (res, location) => {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
};

const esc = (s='') => String(s).replace(/[&<>\"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));

function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAdmin(url) { return url.searchParams.get('key') === ADMIN_KEY; }
function isBridge(url) { return url.searchParams.get('bridge_key') === BRIDGE_KEY; }

async function getCreds() {
  const [clientId, clientSecret] = await redis.mGet(['trakt:client_id','trakt:client_secret']);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function getStoredTokens() {
  const raw = await redis.get('trakt:tokens');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveTokens(tokens) {
  await redis.set('trakt:tokens', JSON.stringify(tokens));
}

function expiryMs(tokens) {
  if (!tokens) return 0;
  const created = Number(tokens.created_at || 0) * 1000;
  const life = Number(tokens.expires_in || 0) * 1000;
  return created + life;
}

async function refreshTokens(force = false, redirectUri) {
  const creds = await getCreds();
  let tokens = await getStoredTokens();
  if (!creds || !tokens?.refresh_token) throw new Error('Trakt is not connected');
  if (!force && expiryMs(tokens) - Date.now() > 6 * 60 * 60 * 1000) return tokens;

  const resp = await fetch('https://auth.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      refresh_token: tokens.refresh_token,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'refresh_token',
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Trakt refresh failed: HTTP ${resp.status} ${text}`);
  tokens = JSON.parse(text);
  await saveTokens(tokens);
  return tokens;
}

async function traktFetch(req, path, options = {}) {
  const creds = await getCreds();
  if (!creds) throw new Error('Trakt app credentials are not configured');
  const redirectUri = `${publicBase(req)}/oauth/callback`;
  let tokens = await refreshTokens(false, redirectUri);

  const send = async () => fetch(`https://api.trakt.tv${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.clientId,
      'authorization': `Bearer ${tokens.access_token}`,
      ...(options.headers || {}),
    },
  });

  let resp = await send();
  if (resp.status === 401) {
    tokens = await refreshTokens(true, redirectUri);
    resp = await send();
  }
  return resp;
}

function normalizeIds(body) {
  const src = { ...(body.ids || {}) };
  const maybeImdb = [body.videoId, body.metaId].find((v) => typeof v === 'string' && /^tt\d+$/.test(v));
  if (!src.imdb && maybeImdb) src.imdb = maybeImdb;
  const out = {};
  if (src.imdb && /^tt\d+$/.test(String(src.imdb))) out.imdb = String(src.imdb);
  for (const k of ['tmdb','tvdb','trakt']) {
    const n = Number(src[k]);
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}

function targetFor(body) {
  const ids = normalizeIds(body);
  if (!Object.keys(ids).length) return null;
  const season = Number(body.season);
  const episode = Number(body.episode);
  const isEpisode = body.scope === 'episode' || (Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0);
  if (isEpisode) {
    return { kind: 'episode', ids, season, episode, payload: { show: { ids }, episode: { season, number: episode } } };
  }
  return { kind: 'movie', ids, payload: { movie: { ids } } };
}

function progressFor(body) {
  const p = Number(body.positionMs);
  const d = Number(body.durationMs);
  if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0) return 0;
  return Math.max(0, Math.min(100, (p / d) * 100));
}

function keyFor(target) {
  const id = target.ids.imdb || target.ids.tmdb || target.ids.tvdb || target.ids.trakt;
  return target.kind === 'episode' ? `${id}:s${target.season}e${target.episode}` : String(id);
}

function historyPayload(target, body, remove = false) {
  const watchedAt = new Date((Number(body.at) || Math.floor(Date.now()/1000)) * 1000).toISOString();
  if (target.kind === 'movie') {
    return { movies: [{ ids: target.ids, ...(remove ? {} : { watched_at: watchedAt }) }] };
  }
  return {
    shows: [{
      ids: target.ids,
      seasons: [{
        number: target.season,
        episodes: [{ number: target.episode, ...(remove ? {} : { watched_at: watchedAt }) }],
      }],
    }],
  };
}

async function handlePush(req, res, url, type, videoId) {
  if (!isBridge(url)) return json(res, 401, { error: 'invalid bridge key' });
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { error: 'invalid json' }); }
  body.videoId ||= videoId;
  const target = targetFor(body);
  if (!target) return json(res, 200, { ok: true, ignored: 'no Trakt-compatible ids' });

  const event = String(body.event || '');
  const k = keyFor(target);
  let path;
  let payload;

  if (['start','pause','stop'].includes(event)) {
    const progress = progressFor(body);
    path = `/scrobble/${event}`;
    payload = { ...target.payload, progress };
    if (event === 'stop' && progress >= 80) await redis.set(`recent-watched-stop:${k}`, '1', { EX: 180 });
  } else if (event === 'played') {
    const recentStop = await redis.get(`recent-watched-stop:${k}`);
    if (recentStop) return json(res, 200, { ok: true, deduped: true });
    path = '/sync/history';
    payload = historyPayload(target, body, false);
  } else if (event === 'unplayed') {
    path = '/sync/history/remove';
    payload = historyPayload(target, body, true);
  } else {
    return json(res, 200, { ok: true, ignored: `unsupported event ${event}` });
  }

  try {
    const tr = await traktFetch(req, path, { method: 'POST', body: JSON.stringify(payload) });
    const text = await tr.text();
    if (!tr.ok) return json(res, tr.status === 401 || tr.status === 403 ? tr.status : 502, { error: `Trakt HTTP ${tr.status}`, details: text.slice(0, 500) });
    return json(res, 200, { ok: true, event, type, traktStatus: tr.status });
  } catch (err) {
    console.error('Push error:', err);
    return json(res, 503, { error: err.message || String(err) });
  }
}

function setupPage(req, connected, hasCreds, username) {
  const base = publicBase(req);
  const admin = encodeURIComponent(ADMIN_KEY);
  const callback = `${base}/oauth/callback`;
  const manifest = `${base}/manifest.json?bridge_key=${encodeURIComponent(BRIDGE_KEY)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odin Trakt Bridge</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.45;color:#171717}code,input{font-family:ui-monospace,monospace}input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}button,a.button{display:inline-block;padding:10px 16px;border:0;border-radius:8px;background:#ed1c24;color:#fff;text-decoration:none;font-weight:650;cursor:pointer}.ok{color:#087f23}.muted{color:#666}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}code{word-break:break-all}</style></head><body><h1>Odin Trakt Bridge</h1><p>Status: <strong class="${connected?'ok':''}">${connected ? `Connected${username ? ` as ${esc(username)}` : ''}` : hasCreds ? 'Trakt app configured, authorization pending' : 'Setup required'}</strong></p><div class="box"><h3>1. Create a Trakt API app</h3><p>Open <a href="https://app.trakt.tv/settings/apps" target="_blank" rel="noreferrer">Trakt API Apps</a>, create an app, and set this exact redirect URI:</p><p><code>${esc(callback)}</code></p><p class="muted">The redirect URI is case-sensitive.</p></div><div class="box"><h3>2. Save Trakt app credentials</h3><form method="post" action="/setup/credentials?key=${admin}"><label>Client ID</label><input name="client_id" required autocomplete="off"><label>Client Secret</label><input name="client_secret" required type="password" autocomplete="off"><button type="submit">Save credentials</button></form></div>${hasCreds ? `<div class="box"><h3>3. Connect your Trakt account</h3><a class="button" href="/oauth/start?key=${admin}">${connected?'Reconnect Trakt':'Connect Trakt'}</a></div>` : ''}${connected ? `<div class="box"><h3>4. Add to AIOStreams</h3><p>Use this custom addon manifest URL:</p><p><code>${esc(manifest)}</code></p></div>` : ''}</body></html>`;
}

async function handler(req, res) {
  const url = new URL(req.url, publicBase(req));
  const path = url.pathname;

  if (path === '/healthz') return json(res, 200, { ok: true });
  if (path === '/') return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);

  if (path === '/manifest.json') {
    if (!isBridge(url)) return json(res, 401, { error: 'invalid bridge key' });
    return json(res, 200, {
      id: 'community.odin.trakt.bridge',
      version: '1.0.0',
      name: 'Odin Trakt Bridge',
      description: 'Tracks Odin/AIOStreams Jellyfin playback in Trakt.',
      resources: [{ name: 'watch_state', types: ['movie','series'] }],
      types: ['movie','series'],
      catalogs: [],
      watchState: { version: 1, push: { events: ['start','pause','stop','played','unplayed'] } },
      behaviorHints: { configurable: false, configurationRequired: false },
    });
  }

  if (path === '/setup' && req.method === 'GET') {
    if (!isAdmin(url)) return html(res, 403, '<h1>Forbidden</h1>');
    const creds = await getCreds();
    const tokens = await getStoredTokens();
    let connected = !!tokens?.access_token;
    let username = '';
    if (connected) {
      try {
        const tr = await traktFetch(req, '/users/settings');
        if (tr.ok) {
          const settings = await tr.json();
          username = settings?.user?.username || settings?.user?.name || '';
        } else connected = false;
      } catch { connected = false; }
    }
    return html(res, 200, setupPage(req, connected, !!creds, username));
  }

  if (path === '/setup/credentials' && req.method === 'POST') {
    if (!isAdmin(url)) return html(res, 403, '<h1>Forbidden</h1>');
    const form = new URLSearchParams(await readBody(req));
    const clientId = form.get('client_id')?.trim();
    const clientSecret = form.get('client_secret')?.trim();
    if (!clientId || !clientSecret) return html(res, 400, '<h1>Missing client ID or secret</h1>');
    await redis.mSet({ 'trakt:client_id': clientId, 'trakt:client_secret': clientSecret });
    await redis.del('trakt:tokens');
    return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
  }

  if (path === '/oauth/start' && req.method === 'GET') {
    if (!isAdmin(url)) return html(res, 403, '<h1>Forbidden</h1>');
    const creds = await getCreds();
    if (!creds) return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
    const state = randomBytes(24).toString('hex');
    await redis.set(`oauth-state:${state}`, '1', { EX: 600 });
    const redirectUri = `${publicBase(req)}/oauth/callback`;
    const auth = new URL('https://trakt.tv/oauth/authorize');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', creds.clientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('state', state);
    return redirect(res, auth.toString());
  }

  if (path === '/oauth/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || !(await redis.get(`oauth-state:${state}`))) return html(res, 400, '<h1>Invalid or expired OAuth request</h1>');
    await redis.del(`oauth-state:${state}`);
    const creds = await getCreds();
    if (!creds) return html(res, 400, '<h1>Trakt app credentials missing</h1>');
    const redirectUri = `${publicBase(req)}/oauth/callback`;
    const tr = await fetch('https://auth.trakt.tv/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    const text = await tr.text();
    if (!tr.ok) return html(res, 502, `<h1>Trakt authorization failed</h1><pre>${esc(text)}</pre>`);
    await saveTokens(JSON.parse(text));
    return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
  }

  const m = path.match(/^\/watch_state\/push\/([^/]+)\/([^/]+)\.json$/);
  if (m && req.method === 'POST') return handlePush(req, res, url, decodeURIComponent(m[1]), decodeURIComponent(m[2]));

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Odin Trakt Bridge listening on ${PORT}`));
