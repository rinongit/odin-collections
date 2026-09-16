import http from 'node:http';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 7000);
const MAX_BODY = 512 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const CATALOG_LIMIT = Math.min(200, Math.max(1, Number(process.env.CATALOG_LIMIT || 80)));

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

function sendJson(res, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { ...jsonHeaders, 'content-length': String(body.length), ...extra });
  res.end(body);
}

function sendHtml(res, html) {
  const body = Buffer.from(html);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || crypto.randomBytes(4).toString('hex');
}

function encodeConfig(value) {
  const raw = Buffer.from(JSON.stringify(value));
  return deflateRawSync(raw, { level: 9 }).toString('base64url');
}

function decodeConfig(token) {
  if (!token || token.length > 120000) throw new Error('Invalid configuration token');
  const raw = inflateRawSync(Buffer.from(token, 'base64url'));
  if (raw.length > 1024 * 1024) throw new Error('Configuration is too large');
  return JSON.parse(raw.toString('utf8'));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateV6(ip) {
  const x = ip.toLowerCase();
  return x === '::' || x === '::1' || x.startsWith('fe80:') || x.startsWith('fc') || x.startsWith('fd');
}

async function assertSafeRemoteUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http/https URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in URLs are not allowed');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Local addresses are not allowed');

  if (net.isIP(host)) {
    if ((net.isIPv4(host) && isPrivateV4(host)) || (net.isIPv6(host) && isPrivateV6(host))) {
      throw new Error('Private network addresses are not allowed');
    }
  } else {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length) throw new Error('Host could not be resolved');
    for (const r of records) {
      if ((r.family === 4 && isPrivateV4(r.address)) || (r.family === 6 && isPrivateV6(r.address))) {
        throw new Error('Private network addresses are not allowed');
      }
    }
  }
  return url;
}

async function safeFetch(input, options = {}, redirects = 0) {
  if (redirects > 4) throw new Error('Too many redirects');
  const url = await assertSafeRemoteUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': 'OdinCatalogBuilder/0.1',
        accept: 'application/json,*/*;q=0.8',
        ...(options.headers || {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error('Redirect without location');
      return safeFetch(new URL(loc, url).toString(), options, redirects + 1);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function safeFetchJson(input) {
  const response = await safeFetch(input);
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('Source response is too large');
  return JSON.parse(text);
}

function normalizeManifestUrl(input) {
  const u = new URL(String(input || '').trim());
  if (!/\/manifest\.json$/i.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/+$/, '') + '/manifest.json';
  }
  return u.toString();
}

function addonBaseFromManifest(manifestUrl) {
  const u = new URL(manifestUrl);
  u.pathname = u.pathname.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  u.search = '';
  u.hash = '';
  return u.toString();
}

function cleanConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const folders = Array.isArray(cfg.folders) ? cfg.folders : [];
  const out = {
    name: String(cfg.name || 'Odin Folders').slice(0, 80),
    description: String(cfg.description || 'Custom folder and catalog addon for AIOStreams and Odin.').slice(0, 300),
    exposeChildCatalogs: cfg.exposeChildCatalogs !== false,
    folders: [],
  };

  const seenFolderIds = new Set();
  for (const f of folders.slice(0, 100)) {
    if (!f || f.enabled === false) continue;
    let id = slug(f.id || f.name);
    while (seenFolderIds.has(id)) id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
    seenFolderIds.add(id);
    const folder = {
      id,
      name: String(f.name || id).slice(0, 100),
      description: String(f.description || '').slice(0, 500),
      image: String(f.image || '').slice(0, 2000),
      background: String(f.background || f.image || '').slice(0, 2000),
      posterShape: ['poster', 'landscape', 'square'].includes(f.posterShape) ? f.posterShape : 'landscape',
      catalogs: [],
    };
    const catalogs = Array.isArray(f.catalogs) ? f.catalogs : [];
    for (const c of catalogs.slice(0, 100)) {
      if (!c || c.enabled === false) continue;
      try {
        const manifestUrl = normalizeManifestUrl(c.manifestUrl);
        folder.catalogs.push({
          id: slug(c.id || c.catalogId || c.name),
          name: String(c.name || c.catalogName || c.catalogId || 'Catalog').slice(0, 120),
          type: ['movie', 'series', 'anime'].includes(c.type) ? c.type : String(c.type || 'movie').slice(0, 40),
          catalogId: String(c.catalogId || c.id || '').slice(0, 160),
          manifestUrl,
          image: String(c.image || '').slice(0, 2000),
          posterShape: ['source', 'poster', 'landscape', 'square'].includes(c.posterShape) ? c.posterShape : 'source',
        });
      } catch {
      }
    }
    out.folders.push(folder);
  }
  return out;
}

function folderMetaId(folderId) {
  return `odin.folder.${folderId}`;
}

function childCatalogId(folder, cat) {
  return `odin.${folder.id}.${cat.id}`.slice(0, 220);
}

function buildManifest(cfg) {
  const catalogs = [{ type: 'movie', id: 'odin-folders', name: 'Folders' }];
  if (cfg.exposeChildCatalogs) {
    for (const folder of cfg.folders) {
      for (const cat of folder.catalogs) {
        catalogs.push({ type: cat.type, id: childCatalogId(folder, cat), name: `${folder.name} • ${cat.name}` });
      }
    }
  }
  const types = [...new Set(['movie', ...catalogs.map((x) => x.type)])];
  return {
    id: `com.odin.catalogbuilder.${crypto.createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 12)}`,
    version: '1.0.0',
    name: cfg.name,
    description: cfg.description,
    resources: ['catalog', 'meta'],
    types,
    idPrefixes: ['odin.folder.', 'tt', 'tmdb:', 'kitsu:'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

function dateOf(meta) {
  return meta?.releaseInfo || meta?.released || meta?.premiere || meta?.year || undefined;
}

function toVideo(meta) {
  if (!meta || !meta.id) return null;
  return {
    id: String(meta.id),
    title: String(meta.name || meta.title || meta.id),
    thumbnail: meta.poster || meta.background || meta.logo || undefined,
    released: dateOf(meta),
  };
}

function transformCatalogMetas(metas, cat) {
  const shape = cat.posterShape;
  return (Array.isArray(metas) ? metas : []).slice(0, CATALOG_LIMIT).map((m) => {
    if (!m || typeof m !== 'object') return m;
    const out = { ...m };
    if (shape !== 'source') out.posterShape = shape;
    if (cat.image && !out.poster) out.poster = cat.image;
    return out;
  });
}

async function fetchSourceCatalog(cat) {
  const base = addonBaseFromManifest(cat.manifestUrl);
  const url = `${base}/catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(cat.catalogId)}.json`;
  const json = await safeFetchJson(url);
  return transformCatalogMetas(json?.metas, cat);
}

async function folderVideos(folder) {
  const results = await Promise.allSettled(folder.catalogs.map(fetchSourceCatalog));
  const seen = new Set();
  const videos = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const meta of r.value) {
      const v = toVideo(meta);
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      videos.push(v);
      if (videos.length >= CATALOG_LIMIT * 3) return videos;
    }
  }
  return videos;
}

function folderCard(folder) {
  return {
    id: folderMetaId(folder.id),
    type: 'movie',
    name: folder.name,
    description: folder.description || `Open ${folder.name}`,
    poster: folder.image || undefined,
    background: folder.background || folder.image || undefined,
    posterShape: folder.posterShape,
  };
}

function findChildCatalog(cfg, id, type) {
  for (const folder of cfg.folders) {
    for (const cat of folder.catalogs) {
      if (childCatalogId(folder, cat) === id && cat.type === type) return { folder, cat };
    }
  }
  return null;
}

const CONFIGURE_HTML = readFileSync(new URL('./configure.html', import.meta.url), 'utf8');

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/configure')) {
      sendHtml(res, CONFIGURE_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'odin-catalog-builder' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/inspect') {
      const input = url.searchParams.get('url');
      if (!input) return sendJson(res, 400, { error: 'Manifest URL is required' });
      const manifestUrl = normalizeManifestUrl(input);
      const manifest = await safeFetchJson(manifestUrl);
      const catalogs = Array.isArray(manifest?.catalogs) ? manifest.catalogs : [];
      sendJson(res, 200, {
        manifestUrl,
        name: manifest?.name || 'Addon',
        description: manifest?.description || '',
        catalogs: catalogs
          .filter((c) => c && c.id && c.type)
          .slice(0, 300)
          .map((c) => ({ id: String(c.id), type: String(c.type), name: String(c.name || c.id) })),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/encode') {
      const body = await readBody(req);
      const cfg = cleanConfig(JSON.parse(body || '{}'));
      const token = encodeConfig(cfg);
      sendJson(res, 200, { token, bytes: token.length });
      return;
    }

    const m = url.pathname.match(/^\/c\/([^/]+)\/(.*)$/);
    if (!m) return sendJson(res, 404, { error: 'Not found' });
    const token = m[1];
    const rest = '/' + m[2];
    const cfg = cleanConfig(decodeConfig(token));

    if (req.method === 'GET' && rest === '/manifest.json') {
      sendJson(res, 200, buildManifest(cfg), { 'cache-control': 'public, max-age=300' });
      return;
    }
    if (req.method === 'GET' && rest === '/config.json') {
      sendJson(res, 200, cfg, { 'cache-control': 'public, max-age=300' });
      return;
    }
    if (req.method === 'GET' && rest === '/catalog/movie/odin-folders.json') {
      sendJson(res, 200, { metas: cfg.folders.map(folderCard) }, { 'cache-control': 'public, max-age=300' });
      return;
    }

    let mm = rest.match(/^\/meta\/movie\/odin\.folder\.([^/]+)\.json$/);
    if (req.method === 'GET' && mm) {
      const folder = cfg.folders.find((f) => f.id === decodeURIComponent(mm[1]));
      if (!folder) return sendJson(res, 404, { error: 'Folder not found' });
      const videos = await folderVideos(folder);
      sendJson(res, 200, { meta: { ...folderCard(folder), videos } }, { 'cache-control': 'public, max-age=180' });
      return;
    }

    mm = rest.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (req.method === 'GET' && mm) {
      const type = decodeURIComponent(mm[1]);
      const id = decodeURIComponent(mm[2]);
      const found = findChildCatalog(cfg, id, type);
      if (!found) return sendJson(res, 404, { error: 'Catalog not found' });
      try {
        const metas = await fetchSourceCatalog(found.cat);
        sendJson(res, 200, { metas }, { 'cache-control': 'public, max-age=180' });
      } catch (e) {
        sendJson(res, 502, { error: `Source catalog failed: ${e.message}` });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = /too large/i.test(e.message) ? 413 : 400;
    sendJson(res, status, { error: e.message || 'Request failed' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Odin Catalog Builder listening on :${PORT}`);
});
