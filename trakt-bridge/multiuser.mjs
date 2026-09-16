import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PUBLIC_BASE = process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const SYNC_SECONDS = Math.max(60, Number(process.env.JELLYFIN_DIRECT_SYNC_SECONDS || 300));
const MAX_WRITES = Math.max(20, Math.min(200, Number(process.env.JELLYFIN_DIRECT_MAX_WRITES || 50)));
const UA = 'OdinTraktBridge/2.0-multiuser (+https://github.com/rinongit/odin-collections)';
const PULL_CACHE_SECONDS = Math.max(30, Number(process.env.TRAKT_PULL_CACHE_SECONDS || 120));
const NONE16 = 0xffff;
const MAX_PAGES = 1000;

if (!REDIS_URL || !ADMIN_KEY) throw new Error('Multi-user bridge requires REDIS_URL and ADMIN_KEY');

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const secret = (bytes = 24) => randomBytes(bytes).toString('hex');
const safeId = (v) => /^[a-f0-9]{12}$/.test(String(v || '')) ? String(v) : '';
const profileKey = (id) => `mu:profile:${id}`;
const tokenKey = (id) => `mu:trakt:tokens:${id}`;
const pullKey = (id) => `mu:pull:${id}`;
const jfKey = (id) => `mu:jf:${id}`;
const watchedKey = (id) => `mu:watched:${id}`;
const resumeKey = (id) => `mu:resume:${id}`;
const statusKey = (id) => `mu:status:${id}`;
const lockKey = (id) => `mu:lock:${id}`;
const recentKey = (id, item) => `mu:recent:${id}:${item}`;

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
async function readBody(req, max = 200_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function base(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function secureEq(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
function authHeader(token = '') {
  const p = [
    'MediaBrowser Client="Odin Trakt Bridge"',
    'Device="Railway"',
    'DeviceId="odin-trakt-bridge-multiuser"',
    'Version="2.0"',
  ];
  if (token) p.push(`Token="${token}"`);
  return p.join(', ');
}
function jfUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}
function normalizeBaseUrl(value) {
  const u = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Jellyfin URL must use http or https');
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString().replace(/\/$/, '');
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
  if (!j?.AccessToken || !j?.User?.Id) throw new Error('Jellyfin login did not return a token/user id');
  return { token: j.AccessToken, userId: j.User.Id, name: j.User.Name || username };
}
async function writeUserData(cfg, itemId, data) {
  const r = await fetch(jfUrl(cfg.baseUrl, `/Users/${encodeURIComponent(cfg.userId)}/Items/${itemId}/UserData`), {
    method: 'POST', headers: jfHeaders(cfg.token), body: JSON.stringify(data), signal: AbortSignal.timeout(30_000),
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
function itemId(kind, imdb, season, episode) {
  const numeric = imdbNumeric(imdb);
  if (numeric == null) return null;
  const kindCode = kind === 'movie' ? 1 : kind === 'episode' ? 4 : 0;
  if (!kindCode) return null;
  const b = Buffer.alloc(16);
  b[0] = 0xa1;
  b[1] = (kindCode << 4) | 1;
  b[2] = kind === 'movie' ? 1 : 2;
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
function parseStateKey(key) {
  const p = String(key).split(':');
  if (p[0] === 'm' && /^tt\d+$/.test(p[1] || '')) return { key, kind: 'movie', imdb: p[1] };
  if (p[0] === 'e' && /^tt\d+$/.test(p[1] || '')) {
    const season = nonNegativeInt(p[2]);
    const episode = positiveInt(p[3]);
    if (season != null && episode != null) return { key, kind: 'episode', imdb: p[1], season, episode };
  }
  return null;
}

async function loadJson(redis, key) {
  const raw = await redis.get(key);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function getProfile(redis, id) {
  if (!safeId(id)) return null;
  return loadJson(redis, profileKey(id));
}
async function saveProfile(redis, profile) {
  await redis.set(profileKey(profile.id), JSON.stringify(profile));
  await redis.sAdd('mu:profiles', profile.id);
}
async function appCreds(redis) {
  const [clientId, clientSecret] = await redis.mGet(['trakt:client_id', 'trakt:client_secret']);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
function tokenExpiry(t) {
  return Number(t?.created_at || 0) * 1000 + Number(t?.expires_in || 0) * 1000;
}
async function getTokens(redis, id) { return loadJson(redis, tokenKey(id)); }
async function saveTokens(redis, id, t) { await redis.set(tokenKey(id), JSON.stringify(t)); }
async function refreshTrakt(redis, req, id, force = false) {
  const c = await appCreds(redis);
  let t = await getTokens(redis, id);
  if (!c || !t?.refresh_token) throw new Error('Trakt is not connected');
  if (!force && tokenExpiry(t) - Date.now() > 6 * 60 * 60 * 1000) return t;
  const r = await fetch('https://auth.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      refresh_token: t.refresh_token,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: `${base(req)}/oauth/callback`,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Trakt refresh HTTP ${r.status}: ${text.slice(0, 180)}`);
  t = JSON.parse(text);
  await saveTokens(redis, id, t);
  return t;
}
async function traktFetch(redis, req, id, path, options = {}) {
  const c = await appCreds(redis);
  if (!c) throw new Error('Trakt app credentials not configured');
  let t = await refreshTrakt(redis, req, id, false);
  const send = () => fetch(`https://api.trakt.tv${path}`, {
    ...options,
    headers: {
      accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA,
      'trakt-api-version': '2', 'trakt-api-key': c.clientId,
      authorization: `Bearer ${t.access_token}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  let r = await send();
  if (r.status === 401) {
    t = await refreshTrakt(redis, req, id, true);
    r = await send();
  }
  return r;
}
async function connectionInfo(redis, req, id) {
  const t = await getTokens(redis, id);
  if (!t?.access_token) return { connected: false, username: '', error: '' };
  try {
    const r = await traktFetch(redis, req, id, '/users/settings');
    const text = await r.text();
    if (!r.ok) return { connected: false, username: '', error: `Trakt HTTP ${r.status}: ${text.slice(0, 180)}` };
    const j = JSON.parse(text);
    return { connected: true, username: j?.user?.username || j?.user?.name || '', error: '' };
  } catch (e) {
    return { connected: false, username: '', error: e?.message || String(e) };
  }
}

function pagedPath(path, page, limit = 250) {
  const u = new URL(path, 'https://api.trakt.tv');
  u.searchParams.set('page', String(page));
  u.searchParams.set('limit', String(limit));
  return `${u.pathname}${u.search}`;
}
async function traktPages(redis, req, id, path, limit = 250) {
  const out = [];
  let page = 1, pageCount = 1;
  while (page <= pageCount && page <= MAX_PAGES) {
    const r = await traktFetch(redis, req, id, pagedPath(path, page, limit));
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
  const imdb = imdbId(row?.movie?.ids), duration = runtimeMs(row?.movie), pct = Number(row?.progress);
  if (!imdb || !duration || !Number.isFinite(pct) || pct <= 0 || pct >= 90) return null;
  return { key: `m:${imdb}`, kind: 'movie', imdb, positionMs: Math.round(duration * pct / 100), durationMs: duration, at: epoch(row?.paused_at) };
}
function resumeEpisode(row) {
  const imdb = imdbId(row?.show?.ids), season = nonNegativeInt(row?.episode?.season), episode = positiveInt(row?.episode?.number);
  const duration = runtimeMs(row?.episode, row?.show), pct = Number(row?.progress);
  if (!imdb || season == null || episode == null || !duration || !Number.isFinite(pct) || pct <= 0 || pct >= 90) return null;
  return { key: `e:${imdb}:${season}:${episode}`, kind: 'episode', imdb, season, episode, positionMs: Math.round(duration * pct / 100), durationMs: duration, at: epoch(row?.paused_at) };
}
function watchedEntries(movieRows, showRows) {
  const out = new Map();
  for (const row of movieRows) {
    const imdb = imdbId(row?.movie?.ids);
    if (imdb) out.set(`m:${imdb}`, { key: `m:${imdb}`, kind: 'movie', imdb, at: epoch(row?.last_watched_at, 0) });
  }
  for (const row of showRows) {
    const imdb = imdbId(row?.show?.ids);
    if (!imdb) continue;
    const showAt = epoch(row?.last_watched_at, 0);
    for (const s of row?.seasons || []) {
      const season = nonNegativeInt(s?.number);
      if (season == null) continue;
      for (const ep of s?.episodes || []) {
        const episode = positiveInt(ep?.number), plays = Number(ep?.plays ?? 1);
        if (episode == null || (Number.isFinite(plays) && plays <= 0)) continue;
        const key = `e:${imdb}:${season}:${episode}`;
        out.set(key, { key, kind: 'episode', imdb, season, episode, at: epoch(ep?.last_watched_at, showAt) });
      }
    }
  }
  return out;
}
async function fetchTraktState(redis, req, id) {
  const [pm, pe, wm, ws] = await Promise.all([
    traktPages(redis, req, id, '/sync/playback/movies?extended=full'),
    traktPages(redis, req, id, '/sync/playback/episodes?extended=full'),
    traktPages(redis, req, id, '/sync/watched/movies'),
    traktPages(redis, req, id, '/sync/watched/shows?extended=progress'),
  ]);
  const resumes = [...pm.map(resumeMovie), ...pe.map(resumeEpisode)].filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));
  return { resumes, watched: watchedEntries(wm, ws) };
}
function pullShape(state) {
  const movies = [], episodes = [], counts = {};
  for (const x of state.watched.values()) {
    if (x.kind === 'movie') movies.push(x.imdb);
    else episodes.push(`${x.imdb}:${x.season}:${x.episode}`);
    counts[x.imdb] = { at: Math.max(counts[x.imdb]?.at || 0, x.at || 0) };
  }
  movies.sort(); episodes.sort();
  const items = state.resumes.map((x) => ({
    type: x.kind === 'movie' ? 'movie' : 'series',
    metaId: x.imdb,
    videoId: x.kind === 'movie' ? x.imdb : `${x.imdb}:${x.season}:${x.episode}`,
    ...(x.kind === 'episode' ? { season: x.season, episode: x.episode } : {}),
    positionMs: x.positionMs,
    durationMs: x.durationMs || 0,
    played: false,
    at: x.at,
  }));
  const watched = { movies, episodes, counts };
  const version = createHash('sha256').update(JSON.stringify(watched)).digest('hex').slice(0, 24);
  return { version, items, watched };
}

function normalizeIds(body) {
  const src = { ...(body.ids || {}) };
  const maybeImdb = [body.videoId, body.metaId].find((v) => typeof v === 'string' && /^tt\d+$/.test(v));
  if (!src.imdb && maybeImdb) src.imdb = maybeImdb;
  const out = {};
  if (src.imdb && /^tt\d+$/.test(String(src.imdb))) out.imdb = String(src.imdb);
  for (const k of ['tmdb', 'tvdb', 'trakt']) {
    const n = Number(src[k]);
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}
function targetFor(body) {
  const ids = normalizeIds(body);
  if (!Object.keys(ids).length) return null;
  const season = Number(body.season), episode = Number(body.episode);
  const isEpisode = body.scope === 'episode' || (Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0);
  if (isEpisode) return { kind: 'episode', ids, season, episode, payload: { show: { ids }, episode: { season, number: episode } } };
  return { kind: 'movie', ids, payload: { movie: { ids } } };
}
function progressFor(body) {
  const p = Number(body.positionMs), d = Number(body.durationMs);
  return Number.isFinite(p) && Number.isFinite(d) && d > 0 ? Math.max(0, Math.min(100, (p / d) * 100)) : 0;
}
function dedupeKey(target) {
  const id = target.ids.imdb || target.ids.tmdb || target.ids.tvdb || target.ids.trakt;
  return target.kind === 'episode' ? `${id}:s${target.season}e${target.episode}` : String(id);
}
function historyPayload(target, body, remove = false) {
  const watchedAt = new Date((Number(body.at) || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  if (target.kind === 'movie') return { movies: [{ ids: target.ids, ...(remove ? {} : { watched_at: watchedAt }) }] };
  return { shows: [{ ids: target.ids, seasons: [{ number: target.season, episodes: [{ number: target.episode, ...(remove ? {} : { watched_at: watchedAt }) }] }] }] };
}
async function pushEvent(redis, req, res, id, type, videoId) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
  body.videoId ||= videoId;
  const target = targetFor(body);
  if (!target) return sendJson(res, 200, { ok: true, ignored: 'no ids' });
  const ev = String(body.event || '');
  let path, payload;
  if (['start', 'pause', 'stop'].includes(ev)) {
    const progress = progressFor(body);
    path = `/scrobble/${ev}`;
    payload = { ...target.payload, progress };
    if (ev === 'stop' && progress >= 80) await redis.set(recentKey(id, dedupeKey(target)), '1', { EX: 180 });
  } else if (ev === 'played') {
    if (await redis.get(recentKey(id, dedupeKey(target)))) return sendJson(res, 200, { ok: true, deduped: true });
    path = '/sync/history'; payload = historyPayload(target, body, false);
  } else if (ev === 'unplayed') {
    path = '/sync/history/remove'; payload = historyPayload(target, body, true);
  } else return sendJson(res, 200, { ok: true, ignored: `unsupported event ${ev}` });

  try {
    const r = await traktFetch(redis, req, id, path, { method: 'POST', body: JSON.stringify(payload) });
    const text = await r.text();
    if (!r.ok) return sendJson(res, r.status === 401 || r.status === 403 ? r.status : 502, { error: `Trakt HTTP ${r.status}`, details: text.slice(0, 300) });
    await redis.del(pullKey(id));
    return sendJson(res, 200, { ok: true, event: ev, type, traktStatus: r.status });
  } catch (e) {
    return sendJson(res, 503, { error: e?.message || String(e) });
  }
}

async function runLimited(items, concurrency, fn) {
  let next = 0; const errors = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { await fn(items[i]); } catch (error) { errors.push({ item: items[i], error }); }
    }
  }));
  return errors;
}

export async function createMultiUserBridge() {
  const redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('Multi-user Redis:', e.message));
  await redis.connect();

  async function listProfiles() {
    const ids = (await redis.sMembers('mu:profiles')).filter(safeId).sort();
    const rows = [];
    for (const id of ids) {
      const p = await getProfile(redis, id);
      if (p) rows.push(p);
    }
    return rows;
  }
  async function getJf(id) { return loadJson(redis, jfKey(id)); }
  async function getStatus(id) { return (await loadJson(redis, statusKey(id))) || {}; }
  async function setStatus(id, patch) {
    const old = await getStatus(id);
    const next = { ...old, ...patch };
    await redis.set(statusKey(id), JSON.stringify(next), { EX: 7 * 24 * 3600 });
    return next;
  }

  async function syncProfile(req, id, reason = 'scheduled') {
    const p = await getProfile(redis, id);
    const cfg = await getJf(id);
    if (!p || !cfg) return { skipped: 'not configured' };
    const got = await redis.set(lockKey(id), String(Date.now()), { NX: true, EX: Math.max(120, SYNC_SECONDS) });
    if (!got) return { skipped: 'already running' };
    await setStatus(id, { running: true, lastRun: new Date().toISOString(), error: '', reason });
    try {
      const state = await fetchTraktState(redis, req, id);
      const appliedWatched = new Set(await redis.sMembers(watchedKey(id)));
      const oldResume = await redis.hGetAll(resumeKey(id));
      const currentResume = new Map(state.resumes.map((x) => [x.key, x]));
      const resumeSet = state.resumes.filter((x) => !Number(oldResume[x.key] || 0) || Math.abs(Number(oldResume[x.key]) - x.positionMs) >= 10_000);
      const watchedSet = [...state.watched.values()].filter((x) => !appliedWatched.has(x.key));
      const resumeClear = Object.keys(oldResume).filter((k) => !currentResume.has(k) && !state.watched.has(k)).map(parseStateKey).filter(Boolean);
      const watchedClear = [...appliedWatched].filter((k) => !state.watched.has(k) && !currentResume.has(k)).map(parseStateKey).filter(Boolean);
      const allOps = [
        ...resumeSet.sort((a, b) => (b.at || 0) - (a.at || 0)).map((entry) => ({ type: 'resume-set', entry })),
        ...watchedSet.sort((a, b) => (b.at || 0) - (a.at || 0)).map((entry) => ({ type: 'watched-set', entry })),
        ...resumeClear.map((entry) => ({ type: 'resume-clear', entry })),
        ...watchedClear.map((entry) => ({ type: 'watched-clear', entry })),
      ];
      const ops = allOps.slice(0, MAX_WRITES);
      let resumeUpdated = 0, resumeCleared = 0, watchedAdded = 0, watchedCleared = 0;
      const failures = await runLimited(ops, 4, async ({ type, entry }) => {
        const iid = itemId(entry.kind, entry.imdb, entry.season, entry.episode);
        if (!iid) return;
        if (type === 'resume-set') {
          await writeUserData(cfg, iid, { Played: false, PlaybackPositionTicks: Math.round(entry.positionMs * 10_000) });
          await redis.hSet(resumeKey(id), entry.key, String(entry.positionMs)); resumeUpdated++;
        } else if (type === 'watched-set') {
          await writeUserData(cfg, iid, { Played: true });
          await redis.sAdd(watchedKey(id), entry.key); await redis.hDel(resumeKey(id), entry.key); watchedAdded++;
        } else if (type === 'resume-clear') {
          await writeUserData(cfg, iid, { Played: false, PlaybackPositionTicks: 0 });
          await redis.hDel(resumeKey(id), entry.key); resumeCleared++;
        } else {
          await writeUserData(cfg, iid, { Played: false });
          await redis.sRem(watchedKey(id), entry.key); watchedCleared++;
        }
      });
      if (failures.length) {
        const first = failures[0].error;
        if (first?.status === 401 || first?.status === 403) throw new Error('Jellyfin token expired; reconnect on this profile setup page');
        throw new Error(`${failures.length} Jellyfin write(s) failed; first: ${first?.message || first}`);
      }
      const stats = { traktResume: state.resumes.length, traktWatched: state.watched.size, resumeUpdated, resumeCleared, watchedAdded, watchedCleared, writesThisRun: ops.length, pendingWrites: Math.max(0, allOps.length - ops.length) };
      await setStatus(id, { running: false, lastSuccess: new Date().toISOString(), error: '', stats });
      console.log(`Multi-user sync ${id}:`, JSON.stringify(stats));
      return { ok: true, stats };
    } catch (e) {
      const message = e?.message || String(e);
      await setStatus(id, { running: false, error: message.slice(0, 500) });
      console.error(`Multi-user sync ${id}:`, message);
      return { ok: false, error: message };
    } finally {
      await redis.del(lockKey(id)).catch(() => undefined);
    }
  }

  function fakeReqForScheduler() {
    return { headers: { host: PUBLIC_BASE ? new URL(PUBLIC_BASE).host : 'localhost', 'x-forwarded-proto': 'https', 'x-forwarded-host': PUBLIC_BASE ? new URL(PUBLIC_BASE).host : 'localhost' } };
  }
  async function syncAll() {
    const req = fakeReqForScheduler();
    for (const p of await listProfiles()) {
      if (await getJf(p.id)) await syncProfile(req, p.id, 'scheduled');
    }
  }

  function profileSetupPage(req, p, info, cfg, status) {
    const b = base(req);
    const k = encodeURIComponent(p.setupKey);
    const manifest = `${b}/u/${p.id}/${p.bridgeKey}/manifest.json`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odin Trakt Bridge - ${esc(p.name)}</title><style>body{font-family:system-ui;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.45}input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}button,a.btn{display:inline-block;padding:10px 16px;border:0;border-radius:8px;background:#ed1c24;color:#fff;text-decoration:none;font-weight:650;margin:4px}.blue{background:#2563eb!important}.danger{background:#b42318!important}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}code{word-break:break-all}.ok{color:#087f23}.bad{color:#b42318}.muted{color:#666}</style></head><body><h1>${esc(p.name)} — Odin Trakt Bridge</h1><div class="box"><h3>Trakt</h3><p>Status: <strong class="${info.connected ? 'ok' : ''}">${info.connected ? `Connected as ${esc(info.username || 'Trakt user')}` : 'Not connected'}</strong></p>${info.error ? `<p class="bad">${esc(info.error)}</p>` : ''}${!info.connected ? `<a class="btn" href="/u/${p.id}/oauth/start?key=${k}">Connect Trakt</a>` : `<form method="post" action="/u/${p.id}/trakt/disconnect?key=${k}"><button class="danger">Disconnect Trakt</button></form>`}</div><div class="box"><h3>AIOStreams addon</h3><p>After Trakt is connected, add this manifest to AIOStreams:</p><code>${esc(manifest)}</code></div><div class="box"><h3>Trakt → Odin Direct Sync</h3><p>Jellyfin: <strong>${cfg ? `Connected as ${esc(cfg.name || cfg.username)}` : 'Not configured'}</strong></p>${status?.error ? `<p class="bad">${esc(status.error)}</p>` : ''}${status?.lastSuccess ? `<p class="muted">Last success: ${esc(status.lastSuccess)} — ${esc(JSON.stringify(status.stats || {}))}</p>` : ''}<form method="post" action="/u/${p.id}/direct-sync/config?key=${k}"><label>AIOStreams Jellyfin server URL</label><input name="base_url" type="url" value="${esc(cfg?.baseUrl || '')}" required><label>Username / configuration UUID or alias</label><input name="username" value="${esc(cfg?.username || '')}" required><label>Password</label><input name="password" type="password" autocomplete="current-password"><button class="blue">Connect Jellyfin</button></form><p class="muted">Password is used only for login and is not stored.</p>${cfg ? `<form method="post" action="/u/${p.id}/direct-sync/run?key=${k}"><button class="blue">Sync now</button></form><form method="post" action="/u/${p.id}/direct-sync/disable?key=${k}"><button class="danger">Disable direct sync</button></form>` : ''}</div></body></html>`;
  }

  async function profilesPage(req) {
    const b = base(req), rows = await listProfiles();
    const cards = rows.map((p) => `<div class="box"><h3>${esc(p.name)}</h3><p>ID: <code>${p.id}</code></p><p>Private setup URL to send to this user:</p><code>${esc(`${b}/u/${p.id}/setup?key=${p.setupKey}`)}</code><form method="post" action="/profiles/delete?key=${encodeURIComponent(ADMIN_KEY)}"><input type="hidden" name="id" value="${p.id}"><button class="danger">Delete profile</button></form></div>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bridge users</title><style>body{font-family:system-ui;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.45}input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}button{padding:10px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:650}.danger{background:#b42318}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}code{word-break:break-all}</style></head><body><h1>Odin Trakt Bridge users</h1><div class="box"><h3>Create user</h3><form method="post" action="/profiles/create?key=${encodeURIComponent(ADMIN_KEY)}"><label>Name</label><input name="name" placeholder="Friend name" required><button>Create profile</button></form></div>${cards || '<p>No extra users yet.</p>'}</body></html>`;
  }

  async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pth = u.pathname;

    if (pth === '/profiles' && req.method === 'GET') {
      if (!secureEq(u.searchParams.get('key'), ADMIN_KEY)) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      sendHtml(res, 200, await profilesPage(req)); return true;
    }
    if (pth === '/profiles/create' && req.method === 'POST') {
      if (!secureEq(u.searchParams.get('key'), ADMIN_KEY)) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      const f = new URLSearchParams(await readBody(req));
      const name = String(f.get('name') || '').trim().slice(0, 80);
      if (!name) { sendHtml(res, 400, '<h1>Name required</h1>'); return true; }
      const profile = { id: secret(6), name, setupKey: secret(24), bridgeKey: secret(24), createdAt: new Date().toISOString() };
      await saveProfile(redis, profile);
      redirect(res, `/profiles?key=${encodeURIComponent(ADMIN_KEY)}`); return true;
    }
    if (pth === '/profiles/delete' && req.method === 'POST') {
      if (!secureEq(u.searchParams.get('key'), ADMIN_KEY)) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      const f = new URLSearchParams(await readBody(req)); const id = safeId(f.get('id'));
      if (id) {
        await redis.del([profileKey(id), tokenKey(id), pullKey(id), jfKey(id), watchedKey(id), resumeKey(id), statusKey(id), lockKey(id)]);
        await redis.sRem('mu:profiles', id);
      }
      redirect(res, `/profiles?key=${encodeURIComponent(ADMIN_KEY)}`); return true;
    }

    if (pth === '/oauth/callback' && req.method === 'GET' && u.searchParams.get('state')) {
      const state = u.searchParams.get('state');
      const saved = await loadJson(redis, `mu:oauth:${state}`);
      if (!saved?.id) return false;
      await redis.del(`mu:oauth:${state}`);
      const profile = await getProfile(redis, saved.id);
      if (!profile) { sendHtml(res, 400, '<h1>Profile no longer exists</h1>'); return true; }
      const code = u.searchParams.get('code');
      if (!code) { sendHtml(res, 400, '<h1>Missing authorization code</h1>'); return true; }
      const c = await appCreds(redis);
      if (!c) { sendHtml(res, 500, '<h1>Owner must configure Trakt app credentials first</h1>'); return true; }
      const r = await fetch('https://auth.trakt.tv/oauth/token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: `${base(req)}/oauth/callback`, grant_type: 'authorization_code' }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await r.text();
      if (!r.ok) { sendHtml(res, 502, `<h1>Trakt token exchange failed</h1><pre>${esc(text.slice(0, 800))}</pre>`); return true; }
      await saveTokens(redis, profile.id, JSON.parse(text)); await redis.del(pullKey(profile.id));
      redirect(res, `/u/${profile.id}/setup?key=${encodeURIComponent(profile.setupKey)}`); return true;
    }

    const m = pth.match(/^\/u\/([a-f0-9]{12})(?:\/(.*))?$/);
    if (!m) return false;
    const id = m[1], rest = m[2] || '';
    const profile = await getProfile(redis, id);
    if (!profile) { sendJson(res, 404, { error: 'profile not found' }); return true; }

    const setupAuthorized = secureEq(u.searchParams.get('key'), profile.setupKey);
    if (rest === 'setup' && req.method === 'GET') {
      if (!setupAuthorized) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      const [info, cfg, st] = await Promise.all([connectionInfo(redis, req, id), getJf(id), getStatus(id)]);
      sendHtml(res, 200, profileSetupPage(req, profile, info, cfg, st)); return true;
    }
    if (rest === 'oauth/start' && req.method === 'GET') {
      if (!setupAuthorized) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      const c = await appCreds(redis);
      if (!c) { sendHtml(res, 500, '<h1>Trakt app credentials not configured by bridge owner</h1>'); return true; }
      const state = secret(24);
      await redis.set(`mu:oauth:${state}`, JSON.stringify({ id }), { EX: 600 });
      const a = new URL('https://trakt.tv/oauth/authorize');
      a.searchParams.set('response_type', 'code'); a.searchParams.set('client_id', c.clientId);
      a.searchParams.set('redirect_uri', `${base(req)}/oauth/callback`); a.searchParams.set('state', state);
      redirect(res, a.toString()); return true;
    }
    if (rest === 'trakt/disconnect' && req.method === 'POST') {
      if (!setupAuthorized) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      await redis.del([tokenKey(id), pullKey(id), watchedKey(id), resumeKey(id), statusKey(id)]);
      redirect(res, `/u/${id}/setup?key=${encodeURIComponent(profile.setupKey)}`); return true;
    }
    if (rest === 'direct-sync/config' && req.method === 'POST') {
      if (!setupAuthorized) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      const f = new URLSearchParams(await readBody(req));
      const baseUrl = normalizeBaseUrl(f.get('base_url'));
      const username = String(f.get('username') || '').trim(), password = String(f.get('password') || '');
      if (!username) throw new Error('Username required');
      const auth = await loginJellyfin(baseUrl, username, password);
      await redis.set(jfKey(id), JSON.stringify({ baseUrl, username, token: auth.token, userId: auth.userId, name: auth.name }));
      await redis.del([watchedKey(id), resumeKey(id), statusKey(id), lockKey(id)]);
      void syncProfile(req, id, 'configured');
      redirect(res, `/u/${id}/setup?key=${encodeURIComponent(profile.setupKey)}`); return true;
    }
    if (rest === 'direct-sync/run' && req.method === 'POST') {
      if (!setupAuthorized) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      void syncProfile(req, id, 'manual');
      redirect(res, `/u/${id}/setup?key=${encodeURIComponent(profile.setupKey)}`); return true;
    }
    if (rest === 'direct-sync/disable' && req.method === 'POST') {
      if (!setupAuthorized) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      await redis.del([jfKey(id), watchedKey(id), resumeKey(id), statusKey(id), lockKey(id)]);
      redirect(res, `/u/${id}/setup?key=${encodeURIComponent(profile.setupKey)}`); return true;
    }

    const parts = rest.split('/');
    if (parts.length >= 2 && secureEq(parts[0], profile.bridgeKey)) {
      const sub = parts.slice(1).join('/');
      if (sub === 'manifest.json' && req.method === 'GET') {
        sendJson(res, 200, {
          id: `community.odin.trakt.bridge.multi.${id}`,
          version: '2.0.0', name: `Odin Trakt Bridge - ${profile.name}`,
          description: 'Isolated two-way Trakt watch-state sync for Odin/AIOStreams.',
          resources: [{ name: 'watch_state', types: ['movie', 'series'] }], types: ['movie', 'series'], catalogs: [],
          watchState: { version: 1, push: { events: ['start', 'pause', 'stop', 'played', 'unplayed'] }, pull: { items: true, watched: true, ttlSeconds: PULL_CACHE_SECONDS } },
          behaviorHints: { configurable: false, configurationRequired: false },
        }); return true;
      }
      if (sub === 'watch_state/pull.json' && req.method === 'GET') {
        try {
          let shaped = await loadJson(redis, pullKey(id));
          if (!shaped) {
            shaped = pullShape(await fetchTraktState(redis, req, id));
            await redis.set(pullKey(id), JSON.stringify(shaped), { EX: PULL_CACHE_SECONDS });
          }
          const since = u.searchParams.get('since');
          sendJson(res, 200, since && since === shaped.version ? { version: shaped.version, items: shaped.items || [] } : shaped);
        } catch (e) {
          sendJson(res, /not connected|credentials|Trakt HTTP 40[13]/i.test(e?.message || '') ? 401 : 502, { error: (e?.message || String(e)).slice(0, 500) });
        }
        return true;
      }
      const pm = sub.match(/^watch_state\/push\/([^/]+)\/([^/]+)\.json$/);
      if (pm && req.method === 'POST') {
        await pushEvent(redis, req, res, id, decodeURIComponent(pm[1]), decodeURIComponent(pm[2])); return true;
      }
    }

    sendJson(res, 404, { error: 'not found' }); return true;
  }

  setTimeout(() => void syncAll(), 15_000).unref?.();
  setInterval(() => void syncAll(), SYNC_SECONDS * 1000).unref?.();
  return { handle, syncAll, listProfiles };
}
