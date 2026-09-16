import http from 'node:http';
import https from 'node:https';
import { createClient } from 'redis';
import { timingSafeEqual } from 'node:crypto';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('REDIS_URL is required');

const redis = createClient({ url: REDIS_URL });
redis.on('error', (e) => console.error('Jellyfin proxy Redis:', e.message));
await redis.connect();

const profileKey = (id) => `jc:profile:${id}`;
const jfKey = (id) => `jc:jf:${id}`;

function secureEq(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}

async function loadJson(key) {
  const raw = await redis.get(key);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function parseProxyTarget(pathname) {
  const m = pathname.match(/^\/jellyfin\/([a-f0-9]{12})\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  return { id: m[1], key: decodeURIComponent(m[2]), rest: m[3] || '/' };
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
  const seriesId = String(item?.SeriesId || '').trim();
  if (seriesId) return `id:${seriesId}`;
  const name = String(item?.SeriesName || '').trim().toLowerCase();
  if (name) return `name:${name}`;
  return `item:${String(item?.Id || '')}`;
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
    let replace = false;
    if (mode === 'upcoming') {
      const oldDate = premiereMs(old.item) ?? Number.MAX_SAFE_INTEGER;
      const newDate = premiereMs(item) ?? Number.MAX_SAFE_INTEGER;
      replace = newDate < oldDate || (newDate === oldDate && compareEpisodeOrder(item, old.item) < 0);
    } else {
      const oldResume = resumeTicks(old.item) > 0;
      const newResume = resumeTicks(item) > 0;
      if (oldResume !== newResume) replace = newResume;
      else replace = compareEpisodeOrder(item, old.item) < 0;
    }
    if (replace) groups.set(key, { item, index: old.index });
  });
  return [...groups.values()].sort((a, b) => a.index - b.index).map((x) => x.item);
}

function transformShelf(path, json) {
  if (!json || !Array.isArray(json.Items)) return json;
  let items = json.Items;
  const now = Date.now();

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

function appendPath(baseUrl, rest, search) {
  const target = new URL(baseUrl);
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = `${basePath}${rest.startsWith('/') ? rest : `/${rest}`}`;
  target.search = search;
  target.hash = '';
  return target;
}

async function resolveProxyTarget(parsed) {
  const [profile, cfg] = await Promise.all([
    loadJson(profileKey(parsed.id)),
    loadJson(jfKey(parsed.id)),
  ]);
  if (!profile || !secureEq(parsed.key, profile.bridgeKey)) return null;
  if (!cfg?.baseUrl) return { profile, cfg: null };
  return { profile, cfg };
}

function rewriteLocation(location, cfgBase, proxyBase) {
  if (!location) return location;
  try {
    const loc = new URL(location, cfgBase);
    const upstream = new URL(cfgBase);
    if (loc.origin !== upstream.origin) return location;
    const basePath = upstream.pathname.replace(/\/+$/, '');
    if (!loc.pathname.startsWith(basePath)) return location;
    const suffix = loc.pathname.slice(basePath.length) || '/';
    return `${proxyBase}${suffix}${loc.search}${loc.hash}`;
  } catch {
    return location;
  }
}

async function proxyToConnectedServer(req, res, parsed) {
  const resolved = await resolveProxyTarget(parsed);
  if (!resolved) {
    sendJson(res, 403, { error: 'invalid Jellyfin Client profile' });
    return;
  }
  if (!resolved.cfg?.baseUrl) {
    sendJson(res, 409, { error: 'Connect your Jellyfin server first' });
    return;
  }

  const upstreamUrl = appendPath(resolved.cfg.baseUrl, parsed.rest, new URL(req.url, 'http://local').search);
  const headers = { ...req.headers, host: upstreamUrl.host };
  delete headers.connection;
  delete headers['proxy-connection'];

  const transform = isResumePath(parsed.rest) || isNextUpPath(parsed.rest) || isUpcomingPath(parsed.rest) || isSystemInfoPath(parsed.rest);
  if (transform) headers['accept-encoding'] = 'identity';

  const proxyBase = `${requestOrigin(req)}/jellyfin/${parsed.id}/${encodeURIComponent(parsed.key)}`;
  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, (upstreamRes) => {
    if (!transform || req.method === 'HEAD') {
      const outHeaders = { ...upstreamRes.headers };
      if (outHeaders.location) outHeaders.location = rewriteLocation(outHeaders.location, resolved.cfg.baseUrl, proxyBase);
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    let size = 0;
    upstreamRes.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 12 * 1024 * 1024) chunks.push(chunk);
    });
    upstreamRes.on('end', () => {
      if (size > 12 * 1024 * 1024) {
        sendJson(res, 502, { error: 'Jellyfin response too large to filter' });
        return;
      }
      const raw = Buffer.concat(chunks);
      const type = String(upstreamRes.headers['content-type'] || '');
      if (!type.includes('json')) {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        res.end(raw);
        return;
      }
      try {
        let value = JSON.parse(raw.toString('utf8'));
        if (isSystemInfoPath(parsed.rest)) value = rewriteSystemInfo(value, proxyBase);
        else value = transformShelf(parsed.rest, value);
        const body = Buffer.from(JSON.stringify(value));
        const outHeaders = { ...upstreamRes.headers };
        delete outHeaders['content-length'];
        delete outHeaders['content-encoding'];
        outHeaders['content-length'] = String(body.length);
        outHeaders['cache-control'] = 'no-store';
        if (outHeaders.location) outHeaders.location = rewriteLocation(outHeaders.location, resolved.cfg.baseUrl, proxyBase);
        res.writeHead(upstreamRes.statusCode || 200, outHeaders);
        res.end(body);
      } catch {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        res.end(raw);
      }
    });
  });

  upstreamReq.setTimeout(120_000, () => upstreamReq.destroy(new Error('upstream timeout')));
  upstreamReq.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: `Jellyfin server unavailable: ${error.message}` });
    else res.end();
  });
  req.pipe(upstreamReq);
}

function injectServerUrl(req, body) {
  const u = new URL(req.url, 'http://local');
  const m = u.pathname.match(/^\/u\/([a-f0-9]{12})\/setup$/);
  if (!m || req.method !== 'GET') return Promise.resolve(body);
  return getProfileCard(m[1], req, body);
}

async function getProfileCard(id, req, body) {
  const profile = await loadJson(profileKey(id));
  if (!profile?.bridgeKey) return body;
  const url = `${requestOrigin(req)}/jellyfin/${id}/${encodeURIComponent(profile.bridgeKey)}`;
  const card = `<div class="box"><h3>Jellyfin Client Server URL</h3><p>Use this URL in your Jellyfin client. It keeps all libraries and catalogs from the server you connected above, while filtering Continue Watching, Next Up and Upcoming.</p><code style="word-break:break-all">${url}</code></div>`;
  const marker = '<!-- jc-transparent-proxy -->';
  if (String(body).includes(marker)) return body;
  const add = `${marker}${card}`;
  return String(body).includes('</body>') ? String(body).replace('</body>', `${add}</body>`) : `${body}${add}`;
}

function proxyToChild(req, res, childPort) {
  const headers = { ...req.headers, host: `127.0.0.1:${childPort}` };
  const u = new URL(req.url, 'http://local');
  const setupPage = req.method === 'GET' && /^\/u\/[a-f0-9]{12}\/setup$/.test(u.pathname);
  if (setupPage) headers['accept-encoding'] = 'identity';

  const childReq = http.request({
    hostname: '127.0.0.1',
    port: childPort,
    method: req.method,
    path: req.url,
    headers,
  }, (childRes) => {
    if (!setupPage || !String(childRes.headers['content-type'] || '').includes('text/html')) {
      res.writeHead(childRes.statusCode || 502, childRes.headers);
      childRes.pipe(res);
      return;
    }
    const chunks = [];
    childRes.on('data', (chunk) => chunks.push(chunk));
    childRes.on('end', async () => {
      let body = Buffer.concat(chunks).toString('utf8');
      body = await injectServerUrl(req, body);
      const outHeaders = { ...childRes.headers };
      delete outHeaders['content-length'];
      delete outHeaders['content-encoding'];
      outHeaders['content-length'] = String(Buffer.byteLength(body));
      outHeaders['cache-control'] = 'no-store';
      res.writeHead(childRes.statusCode || 200, outHeaders);
      res.end(body);
    });
  });
  childReq.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 503, { error: `Jellyfin Client starting: ${error.message}` });
    else res.end();
  });
  req.pipe(childReq);
}

export function startPublicProxy({ port, childPort }) {
  const server = http.createServer(async (req, res) => {
    try {
      const incoming = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const parsed = parseProxyTarget(incoming.pathname);
      if (parsed) {
        await proxyToConnectedServer(req, res, parsed);
        return;
      }
      proxyToChild(req, res, childPort);
    } catch (error) {
      console.error('Jellyfin public proxy:', error?.message || error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Jellyfin Client public proxy listening on ${port}; app backend on ${childPort}`);
  });
  return server;
}
