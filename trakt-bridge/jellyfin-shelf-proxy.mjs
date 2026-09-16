import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const BRIDGE_KEY = String(process.env.BRIDGE_KEY || '');
const OWNER_CFG_KEY = 'jellyfin:direct:config:v1';
const profileKey = (id) => `mu:profile:${id}`;
const jfKey = (id) => `mu:jf:${id}`;

if (!REDIS_URL || !BRIDGE_KEY) throw new Error('Jellyfin shelf proxy requires REDIS_URL and BRIDGE_KEY');

function secureEq(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}

async function loadJson(redis, key) {
  const raw = await redis.get(key);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function parseTarget(pathname) {
  let m = pathname.match(/^\/jellyfin-client\/owner\/([^/]+)(\/.*)?$/);
  if (m) return { kind: 'owner', key: decodeURIComponent(m[1]), rest: m[2] || '/' };
  m = pathname.match(/^\/jellyfin-client\/u\/([a-f0-9]{12})\/([^/]+)(\/.*)?$/);
  if (m) return { kind: 'user', id: m[1], key: decodeURIComponent(m[2]), rest: m[3] || '/' };
  return null;
}

function isResumePath(path) {
  return /(?:^|\/)UserItems\/Resume$/i.test(path) || /(?:^|\/)Users\/[^/]+\/Items\/Resume$/i.test(path);
}
function isNextUpPath(path) {
  return /(?:^|\/)Shows\/NextUp$/i.test(path);
}
function isUpcomingPath(path) {
  return /(?:^|\/)Shows\/Upcoming$/i.test(path);
}
function isSystemInfoPath(path) {
  return /(?:^|\/)System\/Info(?:\/Public)?$/i.test(path);
}

function premiereMs(item) {
  const value = item?.PremiereDate ?? item?.DateCreated ?? '';
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function isEpisodeAired(item, now = Date.now()) {
  if (String(item?.Type || '').toLowerCase() !== 'episode') return true;
  const at = premiereMs(item);
  return at == null || at <= now;
}

function showKey(item) {
  const name = String(item?.SeriesName || '').trim().toLowerCase();
  if (name) return `n:${name}`;
  const id = String(item?.SeriesId || item?.ParentId || '').trim().toLowerCase();
  return id ? `i:${id}` : `x:${String(item?.Id || '')}`;
}

function episodeOrder(item) {
  const season = Number(item?.ParentIndexNumber);
  const episode = Number(item?.IndexNumber);
  return [
    Number.isFinite(season) ? season : Number.MAX_SAFE_INTEGER,
    Number.isFinite(episode) ? episode : Number.MAX_SAFE_INTEGER,
  ];
}

function compareEpisodeOrder(a, b) {
  const [as, ae] = episodeOrder(a);
  const [bs, be] = episodeOrder(b);
  return as - bs || ae - be;
}

function resumeTicks(item) {
  const n = Number(item?.UserData?.PlaybackPositionTicks || 0);
  return Number.isFinite(n) ? n : 0;
}

function onePerShow(items, mode) {
  const groups = new Map();
  items.forEach((item, index) => {
    const key = showKey(item);
    const old = groups.get(key);
    if (!old) {
      groups.set(key, { item, index });
      return;
    }
    let useNew = false;
    if (mode === 'upcoming') {
      const a = premiereMs(old.item) ?? Number.MAX_SAFE_INTEGER;
      const b = premiereMs(item) ?? Number.MAX_SAFE_INTEGER;
      useNew = b < a || (b === a && compareEpisodeOrder(item, old.item) < 0);
    } else {
      const oldResume = resumeTicks(old.item) > 0;
      const newResume = resumeTicks(item) > 0;
      if (newResume !== oldResume) useNew = newResume;
      else useNew = compareEpisodeOrder(item, old.item) < 0;
    }
    if (useNew) groups.set(key, { item, index: old.index });
  });
  return [...groups.values()].sort((a, b) => a.index - b.index).map((x) => x.item);
}

function transformShelf(path, json) {
  if (!json || !Array.isArray(json.Items)) return json;
  const now = Date.now();
  let items = json.Items;

  if (isResumePath(path)) {
    items = items.filter((item) => isEpisodeAired(item, now));
  } else if (isNextUpPath(path)) {
    items = items.filter((item) => isEpisodeAired(item, now));
    items = onePerShow(items, 'next');
  } else if (isUpcomingPath(path)) {
    items = items.filter((item) => !item?.UserData?.Played);
    items = onePerShow(items, 'upcoming');
  }

  return {
    ...json,
    Items: items,
    TotalRecordCount: items.length,
    StartIndex: Number(json.StartIndex || 0),
  };
}

function rewriteSystemInfo(json, proxyBase) {
  if (!json || typeof json !== 'object') return json;
  return {
    ...json,
    ...(Object.prototype.hasOwnProperty.call(json, 'LocalAddress') ? { LocalAddress: proxyBase } : {}),
    ...(Object.prototype.hasOwnProperty.call(json, 'WanAddress') ? { WanAddress: proxyBase } : {}),
  };
}

export async function createJellyfinShelfProxy() {
  const redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('Jellyfin shelf proxy Redis:', e.message));
  await redis.connect();

  async function resolveConfig(target) {
    if (target.kind === 'owner') {
      if (!secureEq(target.key, BRIDGE_KEY)) return null;
      return loadJson(redis, OWNER_CFG_KEY);
    }
    const profile = await loadJson(redis, profileKey(target.id));
    if (!profile || !secureEq(target.key, profile.bridgeKey)) return null;
    return loadJson(redis, jfKey(target.id));
  }

  async function handle(req, res) {
    const incoming = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const target = parseTarget(incoming.pathname);
    if (!target) return false;

    const cfg = await resolveConfig(target);
    if (!cfg?.baseUrl) {
      sendJson(res, 404, { error: 'Jellyfin Client profile is not configured' });
      return true;
    }

    let upstreamBase;
    try {
      upstreamBase = new URL(cfg.baseUrl);
    } catch {
      sendJson(res, 502, { error: 'Configured Jellyfin server URL is invalid' });
      return true;
    }

    const basePath = upstreamBase.pathname.replace(/\/+$/, '');
    upstreamBase.pathname = `${basePath}${target.rest.startsWith('/') ? target.rest : `/${target.rest}`}`;
    upstreamBase.search = incoming.search;
    upstreamBase.hash = '';

    const requestHeaders = { ...req.headers };
    requestHeaders.host = upstreamBase.host;
    if (isResumePath(target.rest) || isNextUpPath(target.rest) || isUpcomingPath(target.rest) || isSystemInfoPath(target.rest)) {
      requestHeaders['accept-encoding'] = 'identity';
    }
    delete requestHeaders.connection;
    delete requestHeaders['proxy-connection'];

    const transport = upstreamBase.protocol === 'https:' ? https : http;
    const proxyBase = `${publicOrigin(req)}${incoming.pathname.slice(0, incoming.pathname.length - target.rest.length)}`.replace(/\/$/, '');
    const shouldTransform = isResumePath(target.rest) || isNextUpPath(target.rest) || isUpcomingPath(target.rest) || isSystemInfoPath(target.rest);

    const upstreamReq = transport.request(
      upstreamBase,
      {
        method: req.method,
        headers: requestHeaders,
      },
      (upstreamRes) => {
        if (!shouldTransform || req.method === 'HEAD') {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          return;
        }

        const chunks = [];
        let size = 0;
        upstreamRes.on('data', (chunk) => {
          size += chunk.length;
          if (size <= 8 * 1024 * 1024) chunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          if (size > 8 * 1024 * 1024) {
            if (!res.headersSent) sendJson(res, 502, { error: 'Jellyfin response too large to filter' });
            return;
          }
          const raw = Buffer.concat(chunks);
          const contentType = String(upstreamRes.headers['content-type'] || '');
          if (!contentType.includes('json')) {
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            res.end(raw);
            return;
          }
          try {
            let value = JSON.parse(raw.toString('utf8'));
            if (isSystemInfoPath(target.rest)) value = rewriteSystemInfo(value, proxyBase);
            else value = transformShelf(target.rest, value);
            const body = Buffer.from(JSON.stringify(value));
            const headers = { ...upstreamRes.headers };
            delete headers['content-length'];
            delete headers['content-encoding'];
            headers['content-length'] = String(body.length);
            headers['cache-control'] = 'no-store';
            res.writeHead(upstreamRes.statusCode || 200, headers);
            res.end(body);
          } catch {
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            res.end(raw);
          }
        });
      }
    );

    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
    upstreamReq.setTimeout(120_000);
    upstreamReq.on('error', (error) => {
      if (!res.headersSent) sendJson(res, 502, { error: `Jellyfin upstream unavailable: ${error.message}` });
      else res.end();
    });
    req.pipe(upstreamReq);
    return true;
  }

  return { handle };
}
