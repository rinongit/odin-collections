import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from 'redis';

const PORT = Number(process.env.PORT || 10000);
const REDIS_URL = process.env.REDIS_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const BRIDGE_KEY = process.env.BRIDGE_KEY;
const PULL_CACHE_SECONDS = Math.max(30, Number(process.env.TRAKT_PULL_CACHE_SECONDS || 120));
const UA = 'OdinTraktBridge/1.5 (+https://github.com/rinongit/odin-collections)';
const PULL_CACHE_KEY = 'trakt:pull-cache:v2';
const MAX_PAGES = 1000;

if (!REDIS_URL || !ADMIN_KEY || !BRIDGE_KEY) process.exit(1);

const redis = createClient({ url: REDIS_URL });
redis.on('error', (e) => console.error('Redis:', e.message));
await redis.connect();

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};
const html = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
};
const redirect = (res, location) => {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
};
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function base(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function body(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 1_000_000) throw new Error('Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function headers(extra = {}) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': UA,
    ...extra,
  };
}

async function creds() {
  const [clientId, clientSecret] = await redis.mGet([
    'trakt:client_id',
    'trakt:client_secret',
  ]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function tokens() {
  const r = await redis.get('trakt:tokens');
  try {
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}

async function saveTokens(t) {
  await redis.set('trakt:tokens', JSON.stringify(t));
}

function expiry(t) {
  return Number(t?.created_at || 0) * 1000 + Number(t?.expires_in || 0) * 1000;
}

async function refresh(req, force = false) {
  const c = await creds();
  let t = await tokens();
  if (!c || !t?.refresh_token) throw new Error('Trakt is not connected');
  if (!force && expiry(t) - Date.now() > 6 * 60 * 60 * 1000) return t;

  const r = await fetch('https://auth.trakt.tv/oauth/token', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      refresh_token: t.refresh_token,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: `${base(req)}/oauth/callback`,
      grant_type: 'refresh_token',
    }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Trakt refresh HTTP ${r.status}: ${txt.slice(0, 300)}`);
  t = JSON.parse(txt);
  await saveTokens(t);
  return t;
}

async function trakt(req, path, options = {}) {
  const c = await creds();
  if (!c) throw new Error('Trakt app credentials not configured');
  let t = await refresh(req, false);
  const send = () =>
    fetch(`https://api.trakt.tv${path}`, {
      ...options,
      headers: headers({
        'trakt-api-version': '2',
        'trakt-api-key': c.clientId,
        authorization: `Bearer ${t.access_token}`,
        ...(options.headers || {}),
      }),
    });
  let r = await send();
  if (r.status === 401) {
    t = await refresh(req, true);
    r = await send();
  }
  return r;
}

async function connection(req) {
  const t = await tokens();
  if (!t?.access_token) return { connected: false, username: '', error: '' };
  try {
    const r = await trakt(req, '/users/settings');
    const txt = await r.text();
    if (!r.ok) {
      console.error('verify', r.status, txt.slice(0, 300));
      return {
        connected: false,
        username: '',
        error: `HTTP ${r.status}: ${txt.slice(0, 180)}`,
      };
    }
    const j = JSON.parse(txt);
    return {
      connected: true,
      username: j?.user?.username || j?.user?.name || '',
      error: '',
    };
  } catch (e) {
    return { connected: false, username: '', error: e.message };
  }
}

function normalizeIds(b) {
  const src = { ...(b.ids || {}) };
  const imdb = [b.videoId, b.metaId].find(
    (v) => typeof v === 'string' && /^tt\d+$/.test(v)
  );
  if (!src.imdb && imdb) src.imdb = imdb;
  const out = {};
  if (src.imdb && /^tt\d+$/.test(String(src.imdb))) out.imdb = String(src.imdb);
  for (const k of ['tmdb', 'tvdb', 'trakt']) {
    const n = Number(src[k]);
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}

function target(b) {
  const ids = normalizeIds(b);
  if (!Object.keys(ids).length) return null;
  const s = Number(b.season);
  const e = Number(b.episode);
  const ep =
    b.scope === 'episode' ||
    (Number.isInteger(s) && s >= 0 && Number.isInteger(e) && e > 0);
  if (ep) {
    return {
      kind: 'episode',
      ids,
      season: s,
      episode: e,
      payload: { show: { ids }, episode: { season: s, number: e } },
    };
  }
  return { kind: 'movie', ids, payload: { movie: { ids } } };
}

function progress(b) {
  const p = Number(b.positionMs);
  const d = Number(b.durationMs);
  return Number.isFinite(p) && Number.isFinite(d) && d > 0
    ? Math.max(0, Math.min(100, (p / d) * 100))
    : 0;
}

function historyPayload(t, b, remove = false) {
  const watched_at = new Date(
    (Number(b.at) || Math.floor(Date.now() / 1000)) * 1000
  ).toISOString();
  if (t.kind === 'movie') {
    return { movies: [{ ids: t.ids, ...(remove ? {} : { watched_at }) }] };
  }
  return {
    shows: [
      {
        ids: t.ids,
        seasons: [
          {
            number: t.season,
            episodes: [
              { number: t.episode, ...(remove ? {} : { watched_at }) },
            ],
          },
        ],
      },
    ],
  };
}

function dedupeKey(t) {
  const id = t.ids.imdb || t.ids.tmdb || t.ids.tvdb || t.ids.trakt;
  return t.kind === 'episode' ? `${id}:s${t.season}e${t.episode}` : String(id);
}

async function invalidatePullCache() {
  await redis.del(PULL_CACHE_KEY).catch(() => undefined);
}

async function push(req, res, type, videoId) {
  let b;
  try {
    b = JSON.parse(await body(req));
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }
  b.videoId ||= videoId;
  const t = target(b);
  if (!t) return json(res, 200, { ok: true, ignored: 'no ids' });

  const ev = String(b.event || '');
  let path;
  let payload;
  if (['start', 'pause', 'stop'].includes(ev)) {
    const p = progress(b);
    path = `/scrobble/${ev}`;
    payload = { ...t.payload, progress: p };
    if (ev === 'stop' && p >= 80) {
      await redis.set(`recent:${dedupeKey(t)}`, '1', { EX: 180 });
    }
  } else if (ev === 'played') {
    if (await redis.get(`recent:${dedupeKey(t)}`)) {
      return json(res, 200, { ok: true, deduped: true });
    }
    path = '/sync/history';
    payload = historyPayload(t, b, false);
  } else if (ev === 'unplayed') {
    path = '/sync/history/remove';
    payload = historyPayload(t, b, true);
  } else {
    return json(res, 200, { ok: true, ignored: `unsupported event ${ev}` });
  }

  try {
    const r = await trakt(req, path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error('push', r.status, txt.slice(0, 300));
      return json(res, r.status === 401 || r.status === 403 ? r.status : 502, {
        error: `Trakt HTTP ${r.status}`,
        details: txt.slice(0, 300),
      });
    }
    await invalidatePullCache();
    return json(res, 200, {
      ok: true,
      event: ev,
      type,
      traktStatus: r.status,
    });
  } catch (e) {
    return json(res, 503, { error: e.message });
  }
}

function epochSeconds(value, fallback = Math.floor(Date.now() / 1000)) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback;
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

function pagedPath(path, page, limit = 250) {
  const u = new URL(path, 'https://api.trakt.tv');
  u.searchParams.set('page', String(page));
  u.searchParams.set('limit', String(limit));
  return `${u.pathname}${u.search}`;
}

async function traktPages(req, path, { limit = 250 } = {}) {
  const all = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount && page <= MAX_PAGES) {
    const r = await trakt(req, pagedPath(path, page, limit));
    const txt = await r.text();
    if (!r.ok) throw new Error(`Trakt HTTP ${r.status}: ${txt.slice(0, 300)}`);
    let rows;
    try {
      rows = JSON.parse(txt);
    } catch {
      throw new Error(`Trakt returned invalid JSON for ${path}`);
    }
    if (!Array.isArray(rows)) throw new Error(`Trakt returned a non-list for ${path}`);
    all.push(...rows);

    const headerCount = Number(r.headers.get('x-pagination-page-count'));
    if (Number.isInteger(headerCount) && headerCount > 0) {
      pageCount = headerCount;
      if (pageCount > MAX_PAGES) {
        throw new Error(`Trakt pagination exceeded ${MAX_PAGES} pages for ${path}`);
      }
    } else if (rows.length >= limit) {
      pageCount = page + 1;
    } else {
      pageCount = page;
    }
    page += 1;
  }
  return all;
}

function movieResume(row) {
  const id = imdbId(row?.movie?.ids);
  const durationMs = runtimeMs(row?.movie);
  const pct = Number(row?.progress);
  if (!id || !durationMs || !Number.isFinite(pct) || pct <= 0 || pct >= 90) return null;
  return {
    type: 'movie',
    metaId: id,
    videoId: id,
    positionMs: Math.round((durationMs * pct) / 100),
    durationMs,
    progressPercent: pct,
    played: false,
    at: epochSeconds(row?.paused_at),
  };
}

function episodeResume(row) {
  const showId = imdbId(row?.show?.ids);
  const season = nonNegativeInt(row?.episode?.season);
  const episode = positiveInt(row?.episode?.number);
  const durationMs = runtimeMs(row?.episode, row?.show);
  const pct = Number(row?.progress);
  if (
    !showId ||
    season == null ||
    episode == null ||
    !durationMs ||
    !Number.isFinite(pct) ||
    pct <= 0 ||
    pct >= 90
  ) {
    return null;
  }
  return {
    type: 'series',
    metaId: showId,
    videoId: `${showId}:${season}:${episode}`,
    season,
    episode,
    positionMs: Math.round((durationMs * pct) / 100),
    durationMs,
    progressPercent: pct,
    played: false,
    at: epochSeconds(row?.paused_at),
  };
}

function watchedState(movieRows, showRows) {
  const movies = [];
  const episodes = [];
  const counts = {};
  const movieSeen = new Set();
  const episodeSeen = new Set();

  for (const row of movieRows) {
    const id = imdbId(row?.movie?.ids);
    if (!id) continue;
    if (!movieSeen.has(id)) {
      movieSeen.add(id);
      movies.push(id);
    }
    const at = epochSeconds(row?.last_watched_at, 0);
    if (at > 0) counts[id] = { at };
  }

  for (const row of showRows) {
    const showId = imdbId(row?.show?.ids);
    if (!showId) continue;
    const showAt = epochSeconds(row?.last_watched_at, 0);
    if (showAt > 0) counts[showId] = { at: showAt };
    for (const seasonRow of row?.seasons || []) {
      const season = Number(seasonRow?.number);
      if (!Number.isInteger(season) || season < 0) continue;
      for (const episodeRow of seasonRow?.episodes || []) {
        const episode = positiveInt(episodeRow?.number);
        if (episode == null) continue;
        const plays = Number(episodeRow?.plays ?? 1);
        if (Number.isFinite(plays) && plays <= 0) continue;
        const videoId = `${showId}:${season}:${episode}`;
        if (!episodeSeen.has(videoId)) {
          episodeSeen.add(videoId);
          episodes.push(videoId);
        }
        const at = epochSeconds(episodeRow?.last_watched_at, 0);
        if (at > (counts[showId]?.at || 0)) counts[showId] = { at };
      }
    }
  }

  movies.sort();
  episodes.sort();
  const orderedCounts = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  );
  return { movies, episodes, counts: orderedCounts };
}

function versionFor(watched) {
  return createHash('sha256')
    .update(JSON.stringify(watched))
    .digest('hex')
    .slice(0, 24);
}

async function readPullCache() {
  const raw = await redis.get(PULL_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchTraktState(req) {
  const [playbackMovies, playbackEpisodes, watchedMovies, watchedShows] =
    await Promise.all([
      traktPages(req, '/sync/playback/movies?extended=full'),
      traktPages(req, '/sync/playback/episodes?extended=full'),
      traktPages(req, '/sync/watched/movies'),
      traktPages(req, '/sync/watched/shows?extended=progress'),
    ]);

  const items = [
    ...playbackMovies.map(movieResume),
    ...playbackEpisodes.map(episodeResume),
  ]
    .filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  const watched = watchedState(watchedMovies, watchedShows);
  const state = { version: versionFor(watched), items, watched };
  await redis.set(PULL_CACHE_KEY, JSON.stringify(state), { EX: PULL_CACHE_SECONDS });
  return state;
}

async function pull(req, res, since) {
  try {
    let state = await readPullCache();
    if (!state) state = await fetchTraktState(req);

    if (since && since === state.version) {
      return json(res, 200, { version: state.version, items: state.items || [] });
    }
    return json(res, 200, state);
  } catch (e) {
    const message = e?.message || String(e);
    console.error('pull', message);
    const status = /not connected|credentials/i.test(message)
      ? 401
      : /Trakt HTTP 40[13]/.test(message)
        ? 401
        : 502;
    return json(res, status, { error: message.slice(0, 500) });
  }
}

function setupPage(req, info, hasCreds) {
  const b = base(req);
  const admin = encodeURIComponent(ADMIN_KEY);
  const manifest = `${b}/${BRIDGE_KEY}/manifest.json`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odin Trakt Bridge</title><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.45}input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}button,a{display:inline-block;padding:10px 16px;border:0;border-radius:8px;background:#ed1c24;color:white;text-decoration:none;font-weight:650}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}code{word-break:break-all}.ok{color:#087f23}.bad{color:#b42318}</style></head><body><h1>Odin Trakt Bridge</h1><p>Two-way Trakt sync: <strong>Odin playback → Trakt</strong> and <strong>Trakt progress/history → Odin Continue Watching &amp; Next Up</strong>.</p><p>Status: <strong class="${info.connected ? 'ok' : ''}">${info.connected ? `Connected${info.username ? ` as ${esc(info.username)}` : ''}` : hasCreds ? 'Trakt app configured — account not connected' : 'Setup required'}</strong></p>${info.error ? `<p class="bad">Diagnostic: ${esc(info.error)}</p>` : ''}<div class="box"><p>Trakt redirect URI:</p><code>${b}/oauth/callback</code></div><div class="box"><form method="post" action="/setup/credentials?key=${admin}"><label>Client ID</label><input name="client_id" required><label>Client Secret</label><input name="client_secret" type="password" required><button>Save credentials</button></form></div>${hasCreds && !info.connected ? `<div class="box"><a href="/oauth/start?key=${admin}">Authorize in Trakt</a></div>` : ''}${info.connected ? `<div class="box"><h3>AIOStreams manifest</h3><code>${esc(manifest)}</code><p>In AIOStreams, both playback reporting and watch-state reading must be enabled.</p></div>` : ''}</body></html>`;
}

async function handler(req, res) {
  const u = new URL(req.url, base(req));
  const p = u.pathname;

  if (p === '/healthz') {
    return json(res, 200, {
      ok: true,
      version: '1.5.0',
      push: true,
      pull: true,
    });
  }
  if (p === '/') return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);

  if (p === '/setup' && req.method === 'GET') {
    if (u.searchParams.get('key') !== ADMIN_KEY) return html(res, 403, '<h1>Forbidden</h1>');
    return html(res, 200, setupPage(req, await connection(req), !!(await creds())));
  }

  if (p === '/setup/credentials' && req.method === 'POST') {
    if (u.searchParams.get('key') !== ADMIN_KEY) return html(res, 403, '<h1>Forbidden</h1>');
    const f = new URLSearchParams(await body(req));
    const id = f.get('client_id')?.trim();
    const sec = f.get('client_secret')?.trim();
    if (!id || !sec) return html(res, 400, '<h1>Missing credentials</h1>');
    await redis.mSet({ 'trakt:client_id': id, 'trakt:client_secret': sec });
    await redis.del('trakt:tokens');
    await invalidatePullCache();
    return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
  }

  if (p === '/oauth/start' && req.method === 'GET') {
    if (u.searchParams.get('key') !== ADMIN_KEY) return html(res, 403, '<h1>Forbidden</h1>');
    const c = await creds();
    if (!c) return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
    const state = randomBytes(24).toString('hex');
    await redis.set(`oauth-state:${state}`, '1', { EX: 600 });
    const a = new URL('https://trakt.tv/oauth/authorize');
    a.searchParams.set('response_type', 'code');
    a.searchParams.set('client_id', c.clientId);
    a.searchParams.set('redirect_uri', `${base(req)}/oauth/callback`);
    a.searchParams.set('state', state);
    return redirect(res, a.toString());
  }

  if (p === '/oauth/callback' && req.method === 'GET') {
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    if (!code || !state || !(await redis.get(`oauth-state:${state}`))) {
      return html(res, 400, '<h1>Invalid authorization</h1>');
    }
    await redis.del(`oauth-state:${state}`);
    const c = await creds();
    const r = await fetch('https://auth.trakt.tv/oauth/token', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: `${base(req)}/oauth/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const txt = await r.text();
    if (!r.ok) {
      return html(
        res,
        502,
        `<h1>Token exchange failed</h1><pre>${esc(txt.slice(0, 800))}</pre>`
      );
    }
    await saveTokens(JSON.parse(txt));
    await invalidatePullCache();
    const info = await connection(req);
    return info.connected
      ? html(
          res,
          200,
          `<h1>Trakt connected successfully</h1><p><a href="/setup?key=${encodeURIComponent(ADMIN_KEY)}">Continue</a></p>`
        )
      : html(
          res,
          502,
          `<h1>Authorized, API verification failed</h1><p>${esc(info.error)}</p>`
        );
  }

  const manifestPath = `/${BRIDGE_KEY}/manifest.json`;
  if (p === manifestPath && req.method === 'GET') {
    return json(res, 200, {
      id: 'community.odin.trakt.bridge',
      version: '1.5.0',
      name: 'Odin Trakt Bridge',
      description:
        'Two-way Trakt watch-state sync for Odin through AIOStreams Jellyfin.',
      resources: [{ name: 'watch_state', types: ['movie', 'series'] }],
      types: ['movie', 'series'],
      catalogs: [],
      watchState: {
        version: 1,
        push: { events: ['start', 'pause', 'stop', 'played', 'unplayed'] },
        pull: { items: true, watched: true, ttlSeconds: PULL_CACHE_SECONDS },
      },
      behaviorHints: { configurable: false, configurationRequired: false },
    });
  }

  const pullPath = `/${BRIDGE_KEY}/watch_state/pull.json`;
  if (p === pullPath && req.method === 'GET') {
    return pull(req, res, u.searchParams.get('since'));
  }

  const rx = new RegExp(
    `^/${escapeRe(BRIDGE_KEY)}/watch_state/push/([^/]+)/([^/]+)\\.json$`
  );
  const m = p.match(rx);
  if (m && req.method === 'POST') {
    return push(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  }

  return json(res, 404, { error: 'not found' });
}

http
  .createServer((req, res) =>
    handler(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    })
  )
  .listen(PORT, '0.0.0.0', () =>
    console.log(`Odin Trakt Bridge 1.5 listening on ${PORT}`)
  );
