import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

function replaceSection(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Watch-state patch failed: ${label}`);
  }
  source = `${source.slice(0, start)}${replacement}\n${source.slice(end)}`;
}

// Current watch-state senders use the v2 contract. Keep the v1 playback
// declaration as well so older Odin/Stremio-compatible front-ends still report.
const oldManifest = `        watchState: {
          version: 1,
          push: { events: ['start', 'pause', 'stop', 'played', 'unplayed'] },
          pull: { items: true, watched: true, ttlSeconds: PULL_CACHE_SECONDS },
        },`;
const newManifest = `        watchState: {
          version: 2,
          push: { events: ['start', 'stop', 'played', 'unplayed'] },
          pull: { items: true, watched: true, ttlSeconds: PULL_CACHE_SECONDS },
        },
        playback: { version: 1, events: ['start', 'stop', 'played', 'unplayed'] },`;
if (source.includes(oldManifest)) source = source.replace(oldManifest, newManifest);
else if (!source.includes("watchState: {\n          version: 2,")) {
  throw new Error('Watch-state patch failed: manifest contract');
}

const helpers = `function mediaIdParts(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 160) return null;
  const parts = raw.split(':').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;

  const first = parts[0];
  if (/^tt\\d+$/i.test(first)) {
    const ids = { imdb: first.toLowerCase() };
    if (parts.length === 1) return { ids, kind: 'movie' };
    if (parts.length === 3) {
      const season = Number(parts[1]);
      const episode = Number(parts[2]);
      if (Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0) {
        return { ids, kind: 'episode', season, episode };
      }
    }
    return null;
  }

  const provider = String(first || '').toLowerCase();
  if (!['tmdb', 'tvdb', 'trakt'].includes(provider)) return null;
  const numeric = Number(parts[1]);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  const ids = { [provider]: numeric };
  if (parts.length === 2) return { ids, kind: 'movie' };
  if (parts.length === 4) {
    const season = Number(parts[2]);
    const episode = Number(parts[3]);
    if (Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0) {
      return { ids, kind: 'episode', season, episode };
    }
  }
  return null;
}
function normalizeIds(body, routeVideoId = '') {
  const src = { ...(body.ids || {}) };
  for (const candidate of [body.metaId, body.videoId, routeVideoId]) {
    const parsed = mediaIdParts(candidate);
    if (!parsed) continue;
    for (const [key, value] of Object.entries(parsed.ids)) {
      if (src[key] == null) src[key] = value;
    }
  }
  const out = {};
  const imdb = src.imdb ?? src.Imdb ?? src.IMDb ?? src.IMDB;
  if (typeof imdb === 'string' && /^tt\\d+$/i.test(imdb)) out.imdb = imdb.toLowerCase();
  for (const k of ['tmdb', 'tvdb', 'trakt']) {
    const direct = src[k] ?? src[k.toUpperCase()];
    const n = Number(direct);
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}
function targetFor(body, type = '', routeVideoId = '') {
  const parsed = mediaIdParts(routeVideoId) || mediaIdParts(body.videoId) || mediaIdParts(body.metaId);
  const ids = normalizeIds(body, routeVideoId);
  if (!Object.keys(ids).length) return null;

  const season = Number(body.season ?? parsed?.season);
  const episode = Number(body.episode ?? parsed?.episode);
  const mediaType = String(type || '').toLowerCase();
  const isEpisode = body.scope === 'episode' || parsed?.kind === 'episode' ||
    ((mediaType === 'series' || mediaType === 'episode') &&
      Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0);

  if (isEpisode) {
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return null;
    return { kind: 'episode', ids, season, episode, payload: { show: { ids }, episode: { season, number: episode } } };
  }
  return { kind: 'movie', ids, payload: { movie: { ids } } };
}
function progressFor(body) {
  const p = Number(body.positionMs);
  const d = Number(body.durationMs);
  if (Number.isFinite(p) && Number.isFinite(d) && d > 0) {
    return Math.max(0, Math.min(100, (p / d) * 100));
  }
  const pct = Number(body.progress);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
}
function effectiveProgress(body, event) {
  const progress = progressFor(body);
  if (event === 'stop' && body.played === true && progress < 80) return 100;
  return progress;
}
function eventDedupeKey(id, eventId) {
  if (typeof eventId !== 'string' || !eventId.trim()) return '';
  const digest = createHash('sha256').update(eventId.trim()).digest('hex').slice(0, 24);
  return \`jc:event:\${id}:\${digest}\`;
}`;
replaceSection('function normalizeIds(body) {', 'function dedupeKey(target) {', helpers, 'media id helpers');

const pushHandler = `async function pushEvent(req, res, id, type, videoId) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
  body.videoId ||= videoId;

  const eventIdKey = eventDedupeKey(id, body.id);
  if (eventIdKey && await redis.get(eventIdKey)) {
    console.log('Watch-state duplicate:', JSON.stringify({ profile: id, event: body.event || '', type, videoId }));
    return sendJson(res, 200, { ok: true, deduped: true });
  }

  const target = targetFor(body, type, videoId);
  if (!target) {
    console.warn('Watch-state ignored (no usable ids):', JSON.stringify({ profile: id, event: body.event || '', type, videoId }));
    return sendJson(res, 200, { ok: true, ignored: 'no ids' });
  }

  const ev = String(body.event || '');
  if (ev === 'progress') {
    return sendJson(res, 200, { ok: true, event: ev, ignored: 'progress event not required' });
  }

  let path;
  let payload;
  let progress = effectiveProgress(body, ev);
  if (['start', 'pause', 'stop'].includes(ev)) {
    // Trakt rejects a stop under 1%. A very short open/close should still be
    // acknowledged so the sender does not retry it forever.
    if (ev === 'stop' && progress < 1 && body.played !== true) {
      if (eventIdKey) await redis.set(eventIdKey, '1', { EX: 6 * 60 * 60 });
      console.log('Watch-state stop skipped below 1%:', JSON.stringify({ profile: id, type, videoId, progress }));
      return sendJson(res, 200, { ok: true, event: ev, skipped: 'below 1%' });
    }
    path = \`/scrobble/\${ev}\`;
    payload = { ...target.payload, progress };
    if (ev === 'start') await redis.del(recentKey(id, dedupeKey(target)));
  } else if (ev === 'played') {
    if (await redis.get(recentKey(id, dedupeKey(target)))) {
      if (eventIdKey) await redis.set(eventIdKey, '1', { EX: 6 * 60 * 60 });
      return sendJson(res, 200, { ok: true, deduped: true });
    }
    path = '/sync/history';
    payload = historyPayload(target, body, false);
  } else if (ev === 'unplayed') {
    path = '/sync/history/remove';
    payload = historyPayload(target, body, true);
  } else {
    console.warn('Watch-state unsupported event:', JSON.stringify({ profile: id, event: ev, type, videoId }));
    return sendJson(res, 200, { ok: true, ignored: \`unsupported event \${ev}\` });
  }

  console.log('Watch-state push:', JSON.stringify({
    profile: id,
    event: ev,
    type,
    videoId,
    progress: Math.round(progress * 10) / 10,
    played: body.played === true,
  }));

  try {
    const r = await traktFetch(id, path, { method: 'POST', body: JSON.stringify(payload) });
    const text = await r.text();
    if (!r.ok) {
      console.error('Watch-state Trakt error:', JSON.stringify({ profile: id, event: ev, type, videoId, status: r.status }));
      return sendJson(res, r.status === 401 || r.status === 403 ? r.status : 502, {
        error: \`Trakt HTTP \${r.status}\`,
        details: text.slice(0, 300),
      });
    }
    if (ev === 'stop' && progress >= 80) {
      await redis.set(recentKey(id, dedupeKey(target)), '1', { EX: 6 * 60 * 60 });
    }
    if (eventIdKey) await redis.set(eventIdKey, '1', { EX: 6 * 60 * 60 });
    await redis.del(pullKey(id));
    console.log('Watch-state Trakt success:', JSON.stringify({ profile: id, event: ev, type, videoId, status: r.status }));
    return sendJson(res, 200, { ok: true, event: ev, type, traktStatus: r.status });
  } catch (e) {
    console.error('Watch-state push failed:', JSON.stringify({ profile: id, event: ev, type, videoId, error: e?.message || String(e) }));
    return sendJson(res, 503, { error: e?.message || String(e) });
  }
}`;
replaceSection('async function pushEvent(req, res, id, type, videoId) {', 'async function runLimited(items, concurrency, fn) {', pushHandler, 'push handler');

const watchRoute = `    const pm = sub.match(/^watch_state\\/push\\/([^/]+)\\/([^/]+)\\.json$/);
    if (pm && req.method === 'POST') {
      await pushEvent(req, res, id, decodeURIComponent(pm[1]), decodeURIComponent(pm[2]));
      return;
    }`;
const dualRoute = `    const pm = sub.match(/^watch_state\\/push\\/([^/]+)\\/([^/]+)\\.json$/);
    if (pm && req.method === 'POST') {
      await pushEvent(req, res, id, decodeURIComponent(pm[1]), decodeURIComponent(pm[2]));
      return;
    }
    const legacy = sub.match(/^playback\\/([^/]+)\\/([^/]+)\\.json$/);
    if (legacy && req.method === 'POST') {
      await pushEvent(req, res, id, decodeURIComponent(legacy[1]), decodeURIComponent(legacy[2]));
      return;
    }`;
if (source.includes(watchRoute)) source = source.replace(watchRoute, dualRoute);
else if (!source.includes("sub.match(/^playback\\/")) throw new Error('Watch-state patch failed: legacy playback route');

await writeFile(file, source, 'utf8');
console.log('Applied watch-state v2 and playback v1 compatibility');
