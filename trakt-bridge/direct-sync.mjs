import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PUBLIC_BASE = process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const SYNC_SECONDS = Math.max(60, Number(process.env.JELLYFIN_DIRECT_SYNC_SECONDS || 300));
const UA = 'OdinTraktBridge/1.6 (+https://github.com/rinongit/odin-collections)';
const CFG_KEY = 'jellyfin:direct:config:v1';
const WATCHED_KEY = 'jellyfin:direct:watched:v1';
const RESUME_KEY = 'jellyfin:direct:resume:v1';
const LOCK_KEY = 'jellyfin:direct:lock:v1';
const STATUS_KEY = 'jellyfin:direct:status:v1';
const MAX_PAGES = 1000;
const NONE16 = 0xffff;

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

async function readBody(req, max = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Jellyfin server URL is required');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Jellyfin URL must use http or https');
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function jfUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function deviceHeader(token = '') {
  const parts = [
    'MediaBrowser Client="Odin Trakt Bridge"',
    'Device="Railway"',
    'DeviceId="odin-trakt-bridge-direct-sync"',
    'Version="1.6.0"',
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(', ');
}

async function authenticateJellyfin(baseUrl, username, password) {
  const response = await fetch(jfUrl(baseUrl, '/Users/AuthenticateByName'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': UA,
      'x-emby-authorization': deviceHeader(),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AIOStreams Jellyfin login HTTP ${response.status}: ${text.slice(0, 180)}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('AIOStreams Jellyfin login returned invalid JSON');
  }
  if (!payload?.AccessToken || !payload?.User?.Id) throw new Error('AIOStreams Jellyfin login did not return a token/user id');
  return { token: payload.AccessToken, userId: payload.User.Id, name: payload.User.Name || username };
}

function jfHeaders(token) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': UA,
    'x-emby-token': token,
    'x-mediabrowser-token': token,
    'x-emby-authorization': deviceHeader(token),
  };
}

async function jfUserData(cfg, itemId, data) {
  const response = await fetch(
    jfUrl(cfg.baseUrl, `/Users/${encodeURIComponent(cfg.userId)}/Items/${itemId}/UserData`),
    {
      method: 'POST',
      headers: jfHeaders(cfg.token),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30_000),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    const e = new Error(`AIOStreams Jellyfin HTTP ${response.status}: ${text.slice(0, 180)}`);
    e.status = response.status;
    throw e;
  }
  return text ? JSON.parse(text) : {};
}

function imdbNumeric(imdb) {
  if (!/^tt\d+$/.test(String(imdb))) return null;
  const n = Number(String(imdb).slice(2));
  return Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 48 - 1 ? n : null;
}

// Mirrors AIOStreams packages/core/src/jellyfin/ids.ts packed IMDb IDs.
function packedImdbItemId(kind, imdb, season, episode) {
  const numeric = imdbNumeric(imdb);
  if (numeric == null) return null;
  const kindCode = kind === 'movie' ? 1 : kind === 'series' ? 2 : kind === 'episode' ? 4 : 0;
  if (!kindCode) return null;
  const mediaCode = kind === 'movie' ? 1 : 2;
  const buf = Buffer.alloc(16);
  buf[0] = 0xa1;
  buf[1] = (kindCode << 4) | 1;
  buf[2] = mediaCode;
  buf.writeUIntBE(numeric, 3, 6);
  buf.writeUInt16BE(kind === 'episode' ? Number(season) : NONE16, 9);
  buf.writeUInt16BE(kind === 'episode' ? Number(episode) : NONE16, 11);
  return buf.toString('hex');
}

function imdbId(ids) {
  const v = ids?.imdb;
  return typeof v === 'string' && /^tt\d+$/.test(v) ? v : null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function runtimeMs(primary, fallback) {
  const minutes = Number(primary?.runtime ?? fallback?.runtime);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;
}

function epochSeconds(value, fallback = Math.floor(Date.now() / 1000)) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback;
}

function publicBase() {
  if (PUBLIC_BASE) return PUBLIC_BASE.replace(/\/$/, '');
  throw new Error('Railway public URL is unavailable');
}

async function traktCredentials(redis) {
  const [clientId, clientSecret] = await redis.mGet(['trakt:client_id', 'trakt:client_secret']);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function traktTokens(redis) {
  const raw = await redis.get('trakt:tokens');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function tokenExpiry(t) {
  return Number(t?.created_at || 0) * 1000 + Number(t?.expires_in || 0) * 1000;
}

async function refreshTrakt(redis, force = false) {
  const creds = await traktCredentials(redis);
  let t = await traktTokens(redis);
  if (!creds || !t?.refresh_token) throw new Error('Trakt is not connected');
  if (!force && tokenExpiry(t) - Date.now() > 6 * 60 * 60 * 1000) return t;
  const response = await fetch('https://auth.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      refresh_token: t.refresh_token,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: `${publicBase()}/oauth/callback`,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Trakt refresh HTTP ${response.status}: ${text.slice(0, 180)}`);
  t = JSON.parse(text);
  await redis.set('trakt:tokens', JSON.stringify(t));
  return t;
}

async function traktFetch(redis, path) {
  const creds = await traktCredentials(redis);
  if (!creds) throw new Error('Trakt app credentials not configured');
  let token = await refreshTrakt(redis, false);
  const send = () => fetch(`https://api.trakt.tv${path}`, {
    headers: {
      accept: 'application/json',
      'user-agent': UA,
      'trakt-api-version': '2',
      'trakt-api-key': creds.clientId,
      authorization: `Bearer ${token.access_token}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  let response = await send();
  if (response.status === 401) {
    token = await refreshTrakt(redis, true);
    response = await send();
  }
  return response;
}

function pagedPath(path, page, limit = 250) {
  const u = new URL(path, 'https://api.trakt.tv');
  u.searchParams.set('page', String(page));
  u.searchParams.set('limit', String(limit));
  return `${u.pathname}${u.search}`;
}

async function traktPages(redis, path, limit = 250) {
  const all = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount && page <= MAX_PAGES) {
    const response = await traktFetch(redis, pagedPath(path, page, limit));
    const text = await response.text();
    if (!response.ok) throw new Error(`Trakt HTTP ${response.status}: ${text.slice(0, 180)}`);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error(`Trakt returned a non-list for ${path}`);
    all.push(...rows);
    const count = Number(response.headers.get('x-pagination-page-count'));
    if (Number.isInteger(count) && count > 0) pageCount = count;
    else pageCount = rows.length >= limit ? page + 1 : page;
    if (pageCount > MAX_PAGES) throw new Error(`Trakt pagination exceeded ${MAX_PAGES} pages`);
    page += 1;
  }
  return all;
}

function resumeMovie(row) {
  const imdb = imdbId(row?.movie?.ids);
  const duration = runtimeMs(row?.movie);
  const pct = Number(row?.progress);
  if (!imdb || !duration || !Number.isFinite(pct) || pct <= 0 || pct >= 90) return null;
  return { key: `m:${imdb}`, kind: 'movie', imdb, positionMs: Math.round(duration * pct / 100), at: epochSeconds(row?.paused_at) };
}

function resumeEpisode(row) {
  const imdb = imdbId(row?.show?.ids);
  const season = nonNegativeInt(row?.episode?.season);
  const episode = positiveInt(row?.episode?.number);
  const duration = runtimeMs(row?.episode, row?.show);
  const pct = Number(row?.progress);
  if (!imdb || season == null || episode == null || !duration || !Number.isFinite(pct) || pct <= 0 || pct >= 90) return null;
  return { key: `e:${imdb}:${season}:${episode}`, kind: 'episode', imdb, season, episode, positionMs: Math.round(duration * pct / 100), at: epochSeconds(row?.paused_at) };
}

function watchedEntries(movieRows, showRows) {
  const map = new Map();
  for (const row of movieRows) {
    const imdb = imdbId(row?.movie?.ids);
    if (!imdb) continue;
    map.set(`m:${imdb}`, { key: `m:${imdb}`, kind: 'movie', imdb });
  }
  for (const row of showRows) {
    const imdb = imdbId(row?.show?.ids);
    if (!imdb) continue;
    for (const s of row?.seasons || []) {
      const season = nonNegativeInt(s?.number);
      if (season == null) continue;
      for (const ep of s?.episodes || []) {
        const episode = positiveInt(ep?.number);
        const plays = Number(ep?.plays ?? 1);
        if (episode == null || (Number.isFinite(plays) && plays <= 0)) continue;
        const key = `e:${imdb}:${season}:${episode}`;
        map.set(key, { key, kind: 'episode', imdb, season, episode });
      }
    }
  }
  return map;
}

async function fetchTraktState(redis) {
  const [playbackMovies, playbackEpisodes, watchedMovies, watchedShows] = await Promise.all([
    traktPages(redis, '/sync/playback/movies?extended=full'),
    traktPages(redis, '/sync/playback/episodes?extended=full'),
    traktPages(redis, '/sync/watched/movies'),
    traktPages(redis, '/sync/watched/shows?extended=progress'),
  ]);
  const resumes = [...playbackMovies.map(resumeMovie), ...playbackEpisodes.map(resumeEpisode)]
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  return { resumes, watched: watchedEntries(watchedMovies, watchedShows) };
}

function itemIdFor(entry) {
  return entry.kind === 'movie'
    ? packedImdbItemId('movie', entry.imdb)
    : packedImdbItemId('episode', entry.imdb, entry.season, entry.episode);
}

function parseKey(key) {
  const parts = String(key).split(':');
  if (parts[0] === 'm' && /^tt\d+$/.test(parts[1] || '')) return { key, kind: 'movie', imdb: parts[1] };
  if (parts[0] === 'e' && /^tt\d+$/.test(parts[1] || '')) {
    const season = nonNegativeInt(parts[2]);
    const episode = positiveInt(parts[3]);
    if (season != null && episode != null) return { key, kind: 'episode', imdb: parts[1], season, episode };
  }
  return null;
}

async function runLimited(items, concurrency, fn) {
  let next = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { await fn(items[i]); }
      catch (e) { errors.push({ item: items[i], error: e }); }
    }
  }));
  return errors;
}

export async function createDirectSync() {
  if (!REDIS_URL || !ADMIN_KEY) throw new Error('Direct sync requires REDIS_URL and ADMIN_KEY');
  const redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('Direct sync Redis:', e.message));
  await redis.connect();

  let localStatus = { configured: false, running: false, lastRun: null, lastSuccess: null, error: '', stats: {} };

  async function getConfig() {
    const raw = await redis.get(CFG_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function saveStatus(patch) {
    localStatus = { ...localStatus, ...patch };
    await redis.set(STATUS_KEY, JSON.stringify(localStatus), { EX: 7 * 24 * 3600 }).catch(() => undefined);
  }

  async function status() {
    const cfg = await getConfig();
    const raw = await redis.get(STATUS_KEY);
    let stored = {};
    try { stored = raw ? JSON.parse(raw) : {}; } catch {}
    return { ...localStatus, ...stored, configured: !!cfg, target: cfg ? { baseUrl: cfg.baseUrl, username: cfg.username, name: cfg.name } : null };
  }

  async function syncNow(reason = 'scheduled') {
    const cfg = await getConfig();
    if (!cfg) {
      await saveStatus({ configured: false, running: false, error: '' });
      return { skipped: 'not configured' };
    }
    const lock = await redis.set(LOCK_KEY, String(Date.now()), { NX: true, EX: Math.max(120, SYNC_SECONDS) });
    if (!lock) return { skipped: 'already running' };

    const started = new Date().toISOString();
    await saveStatus({ configured: true, running: true, lastRun: started, error: '', reason });
    try {
      const state = await fetchTraktState(redis);
      const appliedWatched = new Set(await redis.sMembers(WATCHED_KEY));
      const currentWatched = state.watched;
      const oldResume = await redis.hGetAll(RESUME_KEY);
      const currentResume = new Map(state.resumes.map((r) => [r.key, r]));

      const resumesToSet = state.resumes.filter((r) => {
        const prev = Number(oldResume[r.key] || 0);
        return !prev || Math.abs(prev - r.positionMs) >= 10_000;
      });
      const resumesToClear = Object.keys(oldResume)
        .filter((key) => !currentResume.has(key) && !currentWatched.has(key))
        .map(parseKey)
        .filter(Boolean);
      const watchedToSet = [...currentWatched.values()].filter((x) => !appliedWatched.has(x.key));
      const watchedToClear = [...appliedWatched]
        .filter((key) => !currentWatched.has(key) && !currentResume.has(key))
        .map(parseKey)
        .filter(Boolean);

      let setResume = 0, clearResume = 0, setWatched = 0, clearWatched = 0;
      const failures = [];

      failures.push(...await runLimited(resumesToSet, 4, async (entry) => {
        const itemId = itemIdFor(entry);
        if (!itemId) return;
        await jfUserData(cfg, itemId, { Played: false, PlaybackPositionTicks: Math.round(entry.positionMs * 10_000) });
        await redis.hSet(RESUME_KEY, entry.key, String(entry.positionMs));
        setResume++;
      }));

      failures.push(...await runLimited(watchedToSet, 4, async (entry) => {
        const itemId = itemIdFor(entry);
        if (!itemId) return;
        await jfUserData(cfg, itemId, { Played: true });
        await redis.sAdd(WATCHED_KEY, entry.key);
        await redis.hDel(RESUME_KEY, entry.key);
        setWatched++;
      }));

      failures.push(...await runLimited(resumesToClear, 4, async (entry) => {
        const itemId = itemIdFor(entry);
        if (!itemId) return;
        await jfUserData(cfg, itemId, { Played: false, PlaybackPositionTicks: 0 });
        await redis.hDel(RESUME_KEY, entry.key);
        clearResume++;
      }));

      failures.push(...await runLimited(watchedToClear, 4, async (entry) => {
        const itemId = itemIdFor(entry);
        if (!itemId) return;
        await jfUserData(cfg, itemId, { Played: false });
        await redis.sRem(WATCHED_KEY, entry.key);
        clearWatched++;
      }));

      if (failures.length) {
        const first = failures[0].error;
        if (first?.status === 401 || first?.status === 403) throw new Error('AIOStreams Jellyfin login token is no longer valid; reconnect it on the Direct Sync page');
        throw new Error(`${failures.length} Jellyfin write(s) failed; first error: ${first?.message || first}`);
      }

      const stats = {
        traktResume: state.resumes.length,
        traktWatched: currentWatched.size,
        resumeUpdated: setResume,
        resumeCleared: clearResume,
        watchedAdded: setWatched,
        watchedCleared: clearWatched,
      };
      await saveStatus({ running: false, lastSuccess: new Date().toISOString(), error: '', stats });
      console.log('Direct Trakt -> AIOStreams sync:', JSON.stringify(stats));
      return { ok: true, stats };
    } catch (e) {
      const message = e?.message || String(e);
      console.error('Direct sync:', message);
      await saveStatus({ running: false, error: message.slice(0, 500) });
      return { ok: false, error: message };
    } finally {
      await redis.del(LOCK_KEY).catch(() => undefined);
    }
  }

  async function renderPage(res, key, notice = '') {
    const st = await status();
    const target = st.target;
    html(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trakt → Odin Direct Sync</title><style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.45}input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}button,a.btn{display:inline-block;padding:10px 16px;border:0;border-radius:8px;background:#2563eb;color:white;text-decoration:none;font-weight:650;margin-right:8px}.danger{background:#b42318!important}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}code{word-break:break-all}.ok{color:#087f23}.bad{color:#b42318}.muted{color:#666}</style></head><body><h1>Trakt → Odin Direct Sync</h1><p>This bypasses AIOStreams' disabled addon-pull setting and writes your Trakt watch state directly into its Jellyfin-compatible API.</p>${notice ? `<p class="ok"><strong>${esc(notice)}</strong></p>` : ''}<div class="box"><h3>Status</h3><p>Configured: <strong>${st.configured ? 'Yes' : 'No'}</strong>${target ? ` — ${esc(target.name || target.username)} at <code>${esc(target.baseUrl)}</code>` : ''}</p><p>Last run: ${esc(st.lastRun || 'never')}<br>Last success: ${esc(st.lastSuccess || 'never')}</p>${st.error ? `<p class="bad">${esc(st.error)}</p>` : ''}<p class="muted">${esc(JSON.stringify(st.stats || {}))}</p>${st.configured ? `<form method="post" action="/direct-sync/run?key=${encodeURIComponent(key)}"><button>Sync now</button></form>` : ''}</div><div class="box"><h3>${st.configured ? 'Reconnect / change AIOStreams server' : 'Connect AIOStreams Jellyfin'}</h3><form method="post" action="/direct-sync/config?key=${encodeURIComponent(key)}"><label>Jellyfin server URL (exact server address used in Odin)</label><input name="base_url" type="url" placeholder="https://your-aiostreams-server/..." value="${esc(target?.baseUrl || '')}" required><label>Username / AIOStreams configuration UUID or alias</label><input name="username" value="${esc(target?.username || '')}" required><label>Password</label><input name="password" type="password" autocomplete="current-password"><button>Connect and save token</button></form><p class="muted">The password is used only for the login request and is not stored. The returned Jellyfin access token is stored privately in Railway Redis.</p></div>${st.configured ? `<div class="box"><form method="post" action="/direct-sync/disable?key=${encodeURIComponent(key)}"><button class="danger">Disable direct sync</button></form></div>` : ''}<p><a href="/setup?key=${encodeURIComponent(key)}">Back to Trakt bridge setup</a></p></body></html>`);
  }

  async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!u.pathname.startsWith('/direct-sync')) return false;
    const key = u.searchParams.get('key') || '';
    if (key !== ADMIN_KEY) {
      json(res, 403, { error: 'forbidden' });
      return true;
    }

    try {
      if (u.pathname === '/direct-sync' && req.method === 'GET') {
        await renderPage(res, key);
        return true;
      }
      if (u.pathname === '/direct-sync/status' && req.method === 'GET') {
        json(res, 200, await status());
        return true;
      }
      if (u.pathname === '/direct-sync/config' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const baseUrl = normalizeBaseUrl(form.get('base_url'));
        const username = String(form.get('username') || '').trim();
        const password = String(form.get('password') || '');
        if (!username) throw new Error('Username is required');
        const auth = await authenticateJellyfin(baseUrl, username, password);
        await redis.set(CFG_KEY, JSON.stringify({ baseUrl, username, token: auth.token, userId: auth.userId, name: auth.name }));
        await redis.del(WATCHED_KEY, RESUME_KEY, STATUS_KEY);
        await saveStatus({ configured: true, running: false, lastRun: null, lastSuccess: null, error: '', stats: {} });
        const result = await syncNow('configured');
        const notice = result.ok ? 'Connected. Initial Trakt sync completed.' : 'Connected. Initial sync needs attention; see status below.';
        await renderPage(res, key, notice);
        return true;
      }
      if (u.pathname === '/direct-sync/run' && req.method === 'POST') {
        await syncNow('manual');
        redirect(res, `/direct-sync?key=${encodeURIComponent(key)}`);
        return true;
      }
      if (u.pathname === '/direct-sync/disable' && req.method === 'POST') {
        await redis.del(CFG_KEY, WATCHED_KEY, RESUME_KEY, STATUS_KEY, LOCK_KEY);
        localStatus = { configured: false, running: false, lastRun: null, lastSuccess: null, error: '', stats: {} };
        redirect(res, `/direct-sync?key=${encodeURIComponent(key)}`);
        return true;
      }
      json(res, 404, { error: 'not found' });
      return true;
    } catch (e) {
      const message = e?.message || String(e);
      await saveStatus({ running: false, error: message.slice(0, 500) }).catch(() => undefined);
      html(res, 400, `<h1>Direct sync error</h1><p>${esc(message)}</p><p><a href="/direct-sync?key=${encodeURIComponent(key)}">Back</a></p>`);
      return true;
    }
  }

  setTimeout(() => { void syncNow('startup'); }, 8_000).unref?.();
  setInterval(() => { void syncNow('scheduled'); }, SYNC_SECONDS * 1000).unref?.();

  return { handle, syncNow, status };
}
