import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PUBLIC_BASE = process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const SYNC_SECONDS = Math.max(60, Number(process.env.JELLYFIN_DIRECT_SYNC_SECONDS || 300));
const MAX_WRITES = Math.max(20, Math.min(200, Number(process.env.JELLYFIN_DIRECT_MAX_WRITES || 180)));
const UA = 'OdinTraktBridge/1.6.1 (+https://github.com/rinongit/odin-collections)';
const CFG_KEY = 'jellyfin:direct:config:v1';
const WATCHED_KEY = 'jellyfin:direct:watched:v1';
const RESUME_KEY = 'jellyfin:direct:resume:v1';
const LOCK_KEY = 'jellyfin:direct:lock:v1';
const STATUS_KEY = 'jellyfin:direct:status:v1';
const NONE16 = 0xffff;
const MAX_PAGES = 1000;

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const jfUrl = (base, path) => `${base.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function sendHtml(res, status, value) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(value);
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
  const u = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Jellyfin URL must use http or https');
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString().replace(/\/$/, '');
}
function authHeader(token = '') {
  const p = [
    'MediaBrowser Client="Odin Trakt Bridge"',
    'Device="Railway"',
    'DeviceId="odin-trakt-bridge-direct-sync"',
    'Version="1.6.1"',
  ];
  if (token) p.push(`Token="${token}"`);
  return p.join(', ');
}
async function loginJellyfin(baseUrl, username, password) {
  const r = await fetch(jfUrl(baseUrl, '/Users/AuthenticateByName'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': UA,
      'x-emby-authorization': authHeader(),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`AIOStreams Jellyfin login HTTP ${r.status}: ${text.slice(0, 180)}`);
  const j = JSON.parse(text);
  if (!j?.AccessToken || !j?.User?.Id) throw new Error('AIOStreams Jellyfin login did not return a token/user id');
  return { token: j.AccessToken, userId: j.User.Id, name: j.User.Name || username };
}
function jfHeaders(token) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': UA,
    'x-emby-token': token,
    'x-mediabrowser-token': token,
    'x-emby-authorization': authHeader(token),
  };
}
async function writeUserData(cfg, itemId, data) {
  const r = await fetch(jfUrl(cfg.baseUrl, `/Users/${encodeURIComponent(cfg.userId)}/Items/${itemId}/UserData`), {
    method: 'POST',
    headers: jfHeaders(cfg.token),
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`AIOStreams Jellyfin HTTP ${r.status}: ${text.slice(0, 180)}`);
    e.status = r.status;
    throw e;
  }
}

function imdbNumeric(imdb) {
  if (!/^tt\d+$/.test(String(imdb))) return null;
  const n = Number(String(imdb).slice(2));
  return Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 48 - 1 ? n : null;
}
// Mirrors AIOStreams packages/core/src/jellyfin/ids.ts packed IMDb IDs.
function itemId(kind, imdb, season, episode) {
  const numeric = imdbNumeric(imdb);
  if (numeric == null) return null;
  const kindCode = kind === 'movie' ? 1 : kind === 'episode' ? 4 : 0;
  if (!kindCode) return null;
  const b = Buffer.alloc(16);
  b[0] = 0xa1;
  b[1] = (kindCode << 4) | 1; // IMDb id type = 1
  b[2] = kind === 'movie' ? 1 : 2; // movie=1, series=2
  b.writeUIntBE(numeric, 3, 6);
  b.writeUInt16BE(kind === 'episode' ? Number(season) : NONE16, 9);
  b.writeUInt16BE(kind === 'episode' ? Number(episode) : NONE16, 11);
  return b.toString('hex');
}
const imdbId = (ids) => typeof ids?.imdb === 'string' && /^tt\d+$/.test(ids.imdb) ? ids.imdb : null;
const positiveInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const nonNegativeInt = (v) => Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
function epoch(value, fallback = Math.floor(Date.now() / 1000)) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback;
}
function runtimeMs(primary, fallback) {
  const minutes = Number(primary?.runtime ?? fallback?.runtime);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;
}
function parseKey(key) {
  const p = String(key).split(':');
  if (p[0] === 'm' && /^tt\d+$/.test(p[1] || '')) return { key, kind: 'movie', imdb: p[1] };
  if (p[0] === 'e' && /^tt\d+$/.test(p[1] || '')) {
    const season = nonNegativeInt(p[2]);
    const episode = positiveInt(p[3]);
    if (season != null && episode != null) return { key, kind: 'episode', imdb: p[1], season, episode };
  }
  return null;
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
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
const tokenExpiry = (t) => Number(t?.created_at || 0) * 1000 + Number(t?.expires_in || 0) * 1000;
async function refreshTrakt(redis, force = false) {
  const c = await traktCredentials(redis);
  let t = await traktTokens(redis);
  if (!c || !t?.refresh_token) throw new Error('Trakt is not connected');
  if (!force && tokenExpiry(t) - Date.now() > 6 * 60 * 60 * 1000) return t;
  const r = await fetch('https://auth.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      refresh_token: t.refresh_token,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: `${publicBase()}/oauth/callback`,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Trakt refresh HTTP ${r.status}: ${text.slice(0, 180)}`);
  t = JSON.parse(text);
  await redis.set('trakt:tokens', JSON.stringify(t));
  return t;
}
async function traktFetch(redis, path) {
  const c = await traktCredentials(redis);
  if (!c) throw new Error('Trakt app credentials not configured');
  let t = await refreshTrakt(redis);
  const send = () => fetch(`https://api.trakt.tv${path}`, {
    headers: {
      accept: 'application/json', 'user-agent': UA,
      'trakt-api-version': '2', 'trakt-api-key': c.clientId,
      authorization: `Bearer ${t.access_token}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  let r = await send();
  if (r.status === 401) {
    t = await refreshTrakt(redis, true);
    r = await send();
  }
  return r;
}
function pagedPath(path, page, limit = 250) {
  const u = new URL(path, 'https://api.trakt.tv');
  u.searchParams.set('page', String(page));
  u.searchParams.set('limit', String(limit));
  return `${u.pathname}${u.search}`;
}
async function traktPages(redis, path, limit = 250) {
  const out = [];
  let page = 1, pageCount = 1;
  while (page <= pageCount && page <= MAX_PAGES) {
    const r = await traktFetch(redis, pagedPath(path, page, limit));
    const text = await r.text();
    if (!r.ok) throw new Error(`Trakt HTTP ${r.status}: ${text.slice(0, 180)}`);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error(`Trakt returned a non-list for ${path}`);
    out.push(...rows);
    const count = Number(r.headers.get('x-pagination-page-count'));
    pageCount = Number.isInteger(count) && count > 0 ? count : (rows.length >= limit ? page + 1 : page);
    if (pageCount > MAX_PAGES) throw new Error(`Trakt pagination exceeded ${MAX_PAGES} pages`);
    page++;
  }
  return out;
}

function resumeMovie(row) {
  const imdb = imdbId(row?.movie?.ids);
  const duration = runtimeMs(row?.movie);
  const pct = Number(row?.progress);
  if (!imdb || !duration || !Number.isFinite(pct) || pct <= 0 || pct >= 90) return null;
  return { key: `m:${imdb}`, kind: 'movie', imdb, positionMs: Math.round(duration * pct / 100), at: epoch(row?.paused_at) };
}
function resumeEpisode(row) {
  const imdb = imdbId(row?.show?.ids);
  const season = nonNegativeInt(row?.episode?.season);
  const episode = positiveInt(row?.episode?.number);
  const duration = runtimeMs(row?.episode, row?.show);
  const pct = Number(row?.progress);
  if (!imdb || season == null || episode == null || !duration || !Number.isFinite(pct) || pct <= 0 || pct >= 90) return null;
  return { key: `e:${imdb}:${season}:${episode}`, kind: 'episode', imdb, season, episode, positionMs: Math.round(duration * pct / 100), at: epoch(row?.paused_at) };
}
function watchedEntries(movieRows, showRows) {
  const out = new Map();
  for (const row of movieRows) {
    const imdb = imdbId(row?.movie?.ids);
    if (!imdb) continue;
    const key = `m:${imdb}`;
    out.set(key, { key, kind: 'movie', imdb, at: epoch(row?.last_watched_at, 0) });
  }
  for (const row of showRows) {
    const imdb = imdbId(row?.show?.ids);
    if (!imdb) continue;
    const showAt = epoch(row?.last_watched_at, 0);
    for (const s of row?.seasons || []) {
      const season = nonNegativeInt(s?.number);
      if (season == null) continue;
      for (const ep of s?.episodes || []) {
        const episode = positiveInt(ep?.number);
        const plays = Number(ep?.plays ?? 1);
        if (episode == null || (Number.isFinite(plays) && plays <= 0)) continue;
        const key = `e:${imdb}:${season}:${episode}`;
        out.set(key, { key, kind: 'episode', imdb, season, episode, at: epoch(ep?.last_watched_at, showAt) });
      }
    }
  }
  return out;
}
async function fetchTraktState(redis) {
  const [pm, pe, wm, ws] = await Promise.all([
    traktPages(redis, '/sync/playback/movies?extended=full'),
    traktPages(redis, '/sync/playback/episodes?extended=full'),
    traktPages(redis, '/sync/watched/movies'),
    traktPages(redis, '/sync/watched/shows?extended=progress'),
  ]);
  const resumes = [...pm.map(resumeMovie), ...pe.map(resumeEpisode)].filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  return { resumes, watched: watchedEntries(wm, ws) };
}
async function runLimited(items, concurrency, fn) {
  let next = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { await fn(items[i]); } catch (error) { errors.push({ item: items[i], error }); }
    }
  }));
  return errors;
}

export async function createDirectSync() {
  if (!REDIS_URL || !ADMIN_KEY) throw new Error('Direct sync requires REDIS_URL and ADMIN_KEY');
  const redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('Direct sync Redis:', e.message));
  await redis.connect();
  let local = { configured: false, running: false, lastRun: null, lastSuccess: null, error: '', stats: {} };

  async function getConfig() {
    const raw = await redis.get(CFG_KEY);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  async function saveStatus(patch) {
    local = { ...local, ...patch };
    await redis.set(STATUS_KEY, JSON.stringify(local), { EX: 7 * 24 * 3600 }).catch(() => undefined);
  }
  async function status() {
    const cfg = await getConfig();
    const raw = await redis.get(STATUS_KEY);
    let stored = {};
    try { stored = raw ? JSON.parse(raw) : {}; } catch {}
    return {
      ...local, ...stored, configured: !!cfg,
      target: cfg ? { baseUrl: cfg.baseUrl, username: cfg.username, name: cfg.name } : null,
    };
  }

  async function syncNow(reason = 'scheduled') {
    const cfg = await getConfig();
    if (!cfg) {
      await saveStatus({ configured: false, running: false, error: '' });
      return { skipped: 'not configured' };
    }
    const got = await redis.set(LOCK_KEY, String(Date.now()), { NX: true, EX: Math.max(120, SYNC_SECONDS) });
    if (!got) return { skipped: 'already running' };
    await saveStatus({ configured: true, running: true, lastRun: new Date().toISOString(), error: '', reason });
    try {
      const state = await fetchTraktState(redis);
      const appliedWatched = new Set(await redis.sMembers(WATCHED_KEY));
      const oldResume = await redis.hGetAll(RESUME_KEY);
      const currentResume = new Map(state.resumes.map((x) => [x.key, x]));

      const resumeSet = state.resumes.filter((x) => {
        const prev = Number(oldResume[x.key] || 0);
        return !prev || Math.abs(prev - x.positionMs) >= 10_000;
      });
      const watchedSet = [...state.watched.values()].filter((x) => !appliedWatched.has(x.key));
      const resumeClear = Object.keys(oldResume)
        .filter((k) => !currentResume.has(k) && !state.watched.has(k)).map(parseKey).filter(Boolean);
      const watchedClear = [...appliedWatched]
        .filter((k) => !state.watched.has(k) && !currentResume.has(k)).map(parseKey).filter(Boolean);

      const allOps = [
        ...resumeSet.sort((a, b) => (b.at || 0) - (a.at || 0)).map((entry) => ({ type: 'resume-set', entry })),
        ...watchedSet.sort((a, b) => (b.at || 0) - (a.at || 0)).map((entry) => ({ type: 'watched-set', entry })),
        ...resumeClear.map((entry) => ({ type: 'resume-clear', entry })),
        ...watchedClear.map((entry) => ({ type: 'watched-clear', entry })),
      ];
      const ops = allOps.slice(0, MAX_WRITES);
      let resumeUpdated = 0, resumeCleared = 0, watchedAdded = 0, watchedCleared = 0;
      const failures = await runLimited(ops, 4, async ({ type, entry }) => {
        const id = itemId(entry.kind, entry.imdb, entry.season, entry.episode);
        if (!id) return;
        if (type === 'resume-set') {
          await writeUserData(cfg, id, { Played: false, PlaybackPositionTicks: Math.round(entry.positionMs * 10_000) });
          await redis.hSet(RESUME_KEY, entry.key, String(entry.positionMs));
          resumeUpdated++;
        } else if (type === 'watched-set') {
          await writeUserData(cfg, id, { Played: true });
          await redis.sAdd(WATCHED_KEY, entry.key);
          await redis.hDel(RESUME_KEY, entry.key);
          watchedAdded++;
        } else if (type === 'resume-clear') {
          await writeUserData(cfg, id, { Played: false, PlaybackPositionTicks: 0 });
          await redis.hDel(RESUME_KEY, entry.key);
          resumeCleared++;
        } else {
          await writeUserData(cfg, id, { Played: false });
          await redis.sRem(WATCHED_KEY, entry.key);
          watchedCleared++;
        }
      });
      if (failures.length) {
        const first = failures[0].error;
        if (first?.status === 401 || first?.status === 403)
          throw new Error('AIOStreams Jellyfin token is no longer valid; reconnect it on the Direct Sync page');
        throw new Error(`${failures.length} Jellyfin write(s) failed; first error: ${first?.message || first}`);
      }
      const stats = {
        traktResume: state.resumes.length, traktWatched: state.watched.size,
        resumeUpdated, resumeCleared, watchedAdded, watchedCleared,
        writesThisRun: ops.length, pendingWrites: Math.max(0, allOps.length - ops.length),
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
    const t = st.target;
    sendHtml(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trakt → Odin Direct Sync</title><style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.45}input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}button,a.btn{display:inline-block;padding:10px 16px;border:0;border-radius:8px;background:#2563eb;color:white;text-decoration:none;font-weight:650;margin-right:8px}.danger{background:#b42318!important}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}code{word-break:break-all}.ok{color:#087f23}.bad{color:#b42318}.muted{color:#666}</style></head><body><h1>Trakt → Odin Direct Sync</h1><p>This bypasses AIOStreams' disabled addon-pull setting and writes Trakt watch state directly into its Jellyfin-compatible API.</p>${notice ? `<p class="ok"><strong>${esc(notice)}</strong></p>` : ''}<div class="box"><h3>Status</h3><p>Configured: <strong>${st.configured ? 'Yes' : 'No'}</strong>${t ? ` — ${esc(t.name || t.username)} at <code>${esc(t.baseUrl)}</code>` : ''}</p><p>Last run: ${esc(st.lastRun || 'never')}<br>Last success: ${esc(st.lastSuccess || 'never')}</p>${st.error ? `<p class="bad">${esc(st.error)}</p>` : ''}<p class="muted">${esc(JSON.stringify(st.stats || {}))}</p>${st.configured ? `<form method="post" action="/direct-sync/run?key=${encodeURIComponent(key)}"><button>Sync now</button></form>` : ''}</div><div class="box"><h3>${st.configured ? 'Reconnect / change AIOStreams server' : 'Connect AIOStreams Jellyfin'}</h3><form method="post" action="/direct-sync/config?key=${encodeURIComponent(key)}"><label>Jellyfin server URL (exact server address used in Odin)</label><input name="base_url" type="url" placeholder="https://your-aiostreams-server/..." value="${esc(t?.baseUrl || '')}" required><label>Username / AIOStreams configuration UUID or alias</label><input name="username" value="${esc(t?.username || '')}" required><label>Password</label><input name="password" type="password" autocomplete="current-password"><button>Connect and save token</button></form><p class="muted">Your password is used only for the login request and is not stored. Only the returned Jellyfin access token is kept privately in Railway Redis.</p></div>${st.configured ? `<div class="box"><form method="post" action="/direct-sync/disable?key=${encodeURIComponent(key)}"><button class="danger">Disable direct sync</button></form></div>` : ''}<p><a href="/setup?key=${encodeURIComponent(key)}">Back to Trakt bridge setup</a></p></body></html>`);
  }

  async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!u.pathname.startsWith('/direct-sync')) return false;
    const key = u.searchParams.get('key') || '';
    if (key !== ADMIN_KEY) {
      sendJson(res, 403, { error: 'forbidden' });
      return true;
    }
    try {
      if (u.pathname === '/direct-sync' && req.method === 'GET') {
        await renderPage(res, key, u.searchParams.get('notice') || '');
      } else if (u.pathname === '/direct-sync/status' && req.method === 'GET') {
        sendJson(res, 200, await status());
      } else if (u.pathname === '/direct-sync/config' && req.method === 'POST') {
        const f = new URLSearchParams(await readBody(req));
        const baseUrl = normalizeBaseUrl(f.get('base_url'));
        const username = String(f.get('username') || '').trim();
        const password = String(f.get('password') || '');
        if (!username) throw new Error('Username is required');
        const auth = await loginJellyfin(baseUrl, username, password);
        await redis.set(CFG_KEY, JSON.stringify({ baseUrl, username, token: auth.token, userId: auth.userId, name: auth.name }));
        await redis.del([WATCHED_KEY, RESUME_KEY, STATUS_KEY, LOCK_KEY]);
        local = { configured: true, running: false, lastRun: null, lastSuccess: null, error: '', stats: {} };
        await saveStatus(local);
        void syncNow('configured');
        redirect(res, `/direct-sync?key=${encodeURIComponent(key)}&notice=${encodeURIComponent('Connected. Initial Trakt sync started.')}`);
      } else if (u.pathname === '/direct-sync/run' && req.method === 'POST') {
        void syncNow('manual');
        redirect(res, `/direct-sync?key=${encodeURIComponent(key)}&notice=${encodeURIComponent('Sync started.')}`);
      } else if (u.pathname === '/direct-sync/disable' && req.method === 'POST') {
        await redis.del([CFG_KEY, WATCHED_KEY, RESUME_KEY, STATUS_KEY, LOCK_KEY]);
        local = { configured: false, running: false, lastRun: null, lastSuccess: null, error: '', stats: {} };
        redirect(res, `/direct-sync?key=${encodeURIComponent(key)}`);
      } else {
        sendJson(res, 404, { error: 'not found' });
      }
      return true;
    } catch (e) {
      const message = e?.message || String(e);
      await saveStatus({ running: false, error: message.slice(0, 500) }).catch(() => undefined);
      sendHtml(res, 400, `<h1>Direct sync error</h1><p>${esc(message)}</p><p><a href="/direct-sync?key=${encodeURIComponent(key)}">Back</a></p>`);
      return true;
    }
  }

  setTimeout(() => void syncNow('startup'), 8_000).unref?.();
  setInterval(() => void syncNow('scheduled'), SYNC_SECONDS * 1000).unref?.();
  return { handle, syncNow, status };
}
