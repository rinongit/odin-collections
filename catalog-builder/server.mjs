import http from 'node:http';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const PORT = Number(process.env.PORT || 7000);
const MAX_BODY = 512 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const CATALOG_LIMIT = Math.min(200, Math.max(1, Number(process.env.CATALOG_LIMIT || 80)));
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || process.env.TMDB_READ_ACCESS_TOKEN || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || '';
const MDBLIST_API_KEY = process.env.MDBLIST_API_KEY || '';
const credentialContext = new AsyncLocalStorage();
const envCredentials = {
  tmdbBearerToken: TMDB_BEARER_TOKEN,
  tmdbApiKey: TMDB_API_KEY,
  traktClientId: TRAKT_CLIENT_ID,
  mdblistApiKey: MDBLIST_API_KEY,
};
const currentCredentials = () => credentialContext.getStore() || envCredentials;


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

async function safeFetchJson(input, options = {}) {
  const response = await safeFetch(input, options);
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

function detectListSource(input) {
  const sourceUrl = String(input || '').trim();
  const u = new URL(sourceUrl);
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^app\./, '');
  const parts = u.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));

  if (host === 'themoviedb.org' || host === 'api.themoviedb.org') {
    let id = null;
    if (parts[0] === 'list' && /^\d+$/.test(parts[1] || '')) id = parts[1];
    if (parts[0] === '4' && parts[1] === 'list' && /^\d+$/.test(parts[2] || '')) id = parts[2];
    if (!id) throw new Error('TMDB list URL must look like themoviedb.org/list/123');
    return { kind: 'tmdb', sourceUrl, listId: id };
  }

  if (host === 'trakt.tv' || host === 'api.trakt.tv') {
    if (parts[0] === 'users' && parts[1] && parts[2] === 'lists' && parts[3]) {
      return { kind: 'trakt', sourceUrl, mode: 'user', user: parts[1], slug: parts[3] };
    }
    if (parts[0] === 'lists' && parts[1] === 'official' && parts[2]) {
      return { kind: 'trakt', sourceUrl, mode: 'official', slug: parts[2] };
    }
    if (parts[0] === 'lists' && parts[1]) {
      return { kind: 'trakt', sourceUrl, mode: 'global', listId: parts[1] };
    }
    throw new Error('Unsupported Trakt list URL');
  }

  if (host === 'mdblist.com' || host === 'api.mdblist.com') {
    if (parts[0] === 'lists' && parts[1] && parts[2]) {
      return { kind: 'mdblist', sourceUrl, user: parts[1], slug: parts[2] };
    }
    throw new Error('MDBList URL must look like mdblist.com/lists/user/list-name');
  }

  throw new Error('Supported list sources are TMDB, Trakt and MDBList');
}

function sourceCredentials(kind) {
  const c = currentCredentials();
  if (kind === 'tmdb') return Boolean(c.tmdbBearerToken || c.tmdbApiKey);
  if (kind === 'trakt') return Boolean(c.traktClientId);
  if (kind === 'mdblist') return Boolean(c.mdblistApiKey);
  return true;
}

function requireSourceCredentials(kind) {
  if (sourceCredentials(kind)) return;
  const names = {
    tmdb: 'TMDB_BEARER_TOKEN or TMDB_API_KEY',
    trakt: 'TRAKT_CLIENT_ID',
    mdblist: 'MDBLIST_API_KEY',
  };
  throw new Error(`${kind.toUpperCase()} is not configured on the server (${names[kind]} is missing)`);
}

function withQuery(base, params = {}) {
  const u = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') u.searchParams.set(key, String(value));
  }
  return u.toString();
}

async function tmdbFetch(path, params = {}) {
  requireSourceCredentials('tmdb');
  const c = currentCredentials();
  const headers = {};
  if (c.tmdbBearerToken) headers.authorization = `Bearer ${c.tmdbBearerToken}`;
  const query = { ...params };
  if (!c.tmdbBearerToken && c.tmdbApiKey) query.api_key = c.tmdbApiKey;
  return safeFetchJson(withQuery(`https://api.themoviedb.org${path}`, query), { headers });
}

async function traktFetch(path, params = {}) {
  requireSourceCredentials('trakt');
  return safeFetchJson(withQuery(`https://api.trakt.tv${path}`, params), {
    headers: {
      'trakt-api-key': currentCredentials().traktClientId,
      'trakt-api-version': '2',
    },
  });
}

async function mdblistFetch(path, params = {}) {
  requireSourceCredentials('mdblist');
  return safeFetchJson(withQuery(`https://api.mdblist.com${path}`, { ...params, apikey: currentCredentials().mdblistApiKey }));
}

function tmdbImage(path, size = 'w500') {
  if (!path) return undefined;
  const value = String(path);
  if (/^https?:\/\//i.test(value)) return value;
  return `https://image.tmdb.org/t/p/${size}${value.startsWith('/') ? value : `/${value}`}`;
}

function firstImage(value) {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const x = value.trim();
    if (/^https?:\/\//i.test(x)) return x;
    if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(x)) return `https://${x}`;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstImage(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const key of ['full', 'medium', 'thumb', 'url', 'original', 'large']) {
      const found = firstImage(value[key]);
      if (found) return found;
    }
  }
  return undefined;
}

function mediaType(value) {
  const x = String(value || '').toLowerCase();
  if (x === 'movie' || x === 'movies') return 'movie';
  if (['show', 'shows', 'tv', 'series', 'episode'].includes(x)) return 'series';
  return null;
}

function externalId(ids = {}) {
  const imdb = ids.imdb || ids.imdbid || ids.imdb_id;
  if (imdb) return String(imdb);
  const tmdb = ids.tmdb || ids.tmdbid || ids.tmdb_id || ids.id;
  if (tmdb != null && String(tmdb).match(/^\d+$/)) return `tmdb:${tmdb}`;
  return null;
}

async function fetchTmdbList(info, maxItems = CATALOG_LIMIT * 3) {
  const items = [];
  let page = 1;
  let name = '';
  let description = '';
  let totalPages = 1;
  while (items.length < maxItems && page <= Math.min(totalPages, 15)) {
    const json = await tmdbFetch(`/4/list/${encodeURIComponent(info.listId)}`, { language: 'en-US', page });
    if (page === 1) {
      name = json?.name || `TMDB List ${info.listId}`;
      description = json?.description || '';
      totalPages = Math.max(1, Number(json?.total_pages || 1));
    }
    const results = Array.isArray(json?.results) ? json.results : [];
    items.push(...results);
    if (!results.length) break;
    page += 1;
  }
  const metas = items.slice(0, maxItems).map((item) => {
    const type = mediaType(item?.media_type || (item?.title ? 'movie' : 'series'));
    if (!type || !item?.id) return null;
    return {
      id: `tmdb:${item.id}`,
      type,
      name: String(item.title || item.name || `TMDB ${item.id}`),
      poster: tmdbImage(item.poster_path, 'w500'),
      background: tmdbImage(item.backdrop_path, 'w780'),
      description: item.overview || undefined,
      releaseInfo: String(item.release_date || item.first_air_date || '').slice(0, 4) || undefined,
    };
  }).filter(Boolean);
  return { name, description, metas };
}

async function resolveTraktGlobal(info) {
  if (info.mode === 'global' && /^\d+$/.test(String(info.listId || ''))) return { id: info.listId, name: '' };
  if (info.mode === 'official') {
    const results = await traktFetch('/search/list', { query: info.slug, extended: 'full', page: 1, limit: 30 });
    const rows = Array.isArray(results) ? results : [];
    const hit = rows.map((x) => x?.list || x).find((list) => {
      const ids = list?.ids || {};
      return String(ids.slug || '').toLowerCase() === String(info.slug).toLowerCase() ||
        slug(list?.name || '') === slug(info.slug);
    });
    if (!hit?.ids?.trakt) throw new Error('Could not resolve this Trakt official list');
    return { id: hit.ids.trakt, name: hit.name || '' };
  }
  return null;
}

async function fetchTraktList(info, maxItems = CATALOG_LIMIT * 3) {
  const limit = Math.min(1000, Math.max(20, maxItems));
  let path;
  let listMeta = null;
  if (info.mode === 'user') {
    const base = `/users/${encodeURIComponent(info.user)}/lists/${encodeURIComponent(info.slug)}`;
    listMeta = await traktFetch(base, { extended: 'full' }).catch(() => null);
    path = `${base}/items`;
  } else {
    const resolved = await resolveTraktGlobal(info);
    path = `/lists/${encodeURIComponent(resolved?.id || info.listId)}/items`;
    listMeta = resolved?.id ? await traktFetch(`/lists/${encodeURIComponent(resolved.id)}`, { extended: 'full' }).catch(() => null) : null;
    if (!listMeta && resolved?.name) listMeta = { name: resolved.name };
  }
  const rows = await traktFetch(path, { extended: 'full,images', page: 1, limit });
  const metas = (Array.isArray(rows) ? rows : []).slice(0, maxItems).map((row) => {
    const rawType = row?.type || (row?.movie ? 'movie' : row?.show ? 'show' : '');
    const type = mediaType(rawType);
    const media = row?.movie || row?.show || row;
    if (!type || !media) return null;
    const id = externalId(media.ids || {});
    if (!id) return null;
    const images = media.images || row.images || {};
    return {
      id,
      type,
      name: String(media.title || media.name || id),
      poster: firstImage(images.poster) || firstImage(images.thumb) || undefined,
      background: firstImage(images.fanart) || firstImage(images.background) || undefined,
      description: media.overview || undefined,
      releaseInfo: String(media.year || media.released || media.first_aired || '').slice(0, 4) || undefined,
    };
  }).filter(Boolean);
  return {
    name: listMeta?.name || info.slug || `Trakt List ${info.listId || ''}`.trim(),
    description: listMeta?.description || '',
    metas,
  };
}

async function fetchMdblistList(info, maxItems = CATALOG_LIMIT * 3) {
  const path = `/lists/${encodeURIComponent(info.user)}/${encodeURIComponent(info.slug)}`;
  const meta = await mdblistFetch(path).catch(() => null);
  const json = await mdblistFetch(`${path}/items`, { unified: true, limit: Math.min(1000, maxItems), offset: 0 });
  let rows = Array.isArray(json) ? json : [];
  if (!rows.length && json && typeof json === 'object') {
    rows = [...(Array.isArray(json.movies) ? json.movies : []), ...(Array.isArray(json.shows) ? json.shows : [])];
  }
  const metas = rows.slice(0, maxItems).map((item) => {
    const type = mediaType(item?.mediatype || item?.type || (item?.show ? 'show' : item?.movie ? 'movie' : ''));
    const media = item?.movie || item?.show || item;
    if (!type || !media) return null;
    const id = externalId({
      imdb: media.imdbid || media.imdb_id || media.imdb,
      tmdb: media.tmdbid || media.tmdb_id || media.id,
    });
    if (!id) return null;
    return {
      id,
      type,
      name: String(media.title || media.name || id),
      poster: firstImage(media.poster) || firstImage(media.image) || tmdbImage(media.poster_path, 'w500'),
      background: firstImage(media.background) || firstImage(media.backdrop) || tmdbImage(media.backdrop_path, 'w780'),
      description: media.description || media.overview || undefined,
      releaseInfo: String(media.release_year || media.year || media.released || '').slice(0, 4) || undefined,
    };
  }).filter(Boolean);
  return {
    name: meta?.name || meta?.title || info.slug,
    description: meta?.description || '',
    metas,
  };
}

async function fetchListSource(info, maxItems = CATALOG_LIMIT * 3) {
  if (info.kind === 'tmdb') return fetchTmdbList(info, maxItems);
  if (info.kind === 'trakt') return fetchTraktList(info, maxItems);
  if (info.kind === 'mdblist') return fetchMdblistList(info, maxItems);
  throw new Error('Unsupported list source');
}

async function inspectList(input) {
  const info = detectListSource(input);
  requireSourceCredentials(info.kind);
  const result = await fetchListSource(info, Math.max(80, CATALOG_LIMIT * 2));
  const movies = result.metas.filter((m) => m.type === 'movie').length;
  const series = result.metas.filter((m) => m.type === 'series').length;
  const catalogs = [];
  if (movies) catalogs.push({ type: 'movie', id: `${info.kind}-movies`, name: `${result.name} • Movies`, count: movies });
  if (series) catalogs.push({ type: 'series', id: `${info.kind}-series`, name: `${result.name} • Series`, count: series });
  if (!catalogs.length) throw new Error('No movie or series items were found in this list');
  return {
    sourceKind: info.kind,
    sourceUrl: info.sourceUrl,
    name: result.name,
    description: result.description,
    catalogs,
    metas: result.metas,
  };
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
        const requestedKind = String(c.sourceKind || 'addon').toLowerCase();
        const type = ['movie', 'series', 'anime'].includes(c.type) ? c.type : String(c.type || 'movie').slice(0, 40);
        const snapshotMetas = (Array.isArray(c.snapshotMetas) ? c.snapshotMetas : [])
          .filter((m) => m && typeof m === 'object' && m.id && m.type === type)
          .slice(0, CATALOG_LIMIT)
          .map((m) => ({
            id: String(m.id).slice(0, 220),
            type,
            name: String(m.name || m.title || m.id).slice(0, 300),
            poster: String(m.poster || '').slice(0, 2000) || undefined,
            background: String(m.background || '').slice(0, 2000) || undefined,
            releaseInfo: String(m.releaseInfo || m.released || '').slice(0, 40) || undefined,
          }));
        const base = {
          id: slug(c.id || c.catalogId || c.name),
          name: String(c.name || c.catalogName || c.catalogId || 'Catalog').slice(0, 120),
          type,
          catalogId: String(c.catalogId || c.id || '').slice(0, 160),
          image: String(c.image || '').slice(0, 2000),
          posterShape: ['source', 'poster', 'landscape', 'square'].includes(c.posterShape) ? c.posterShape : 'source',
          snapshotMetas,
        };
        if (requestedKind === 'addon') {
          folder.catalogs.push({
            ...base,
            sourceKind: 'addon',
            manifestUrl: normalizeManifestUrl(c.manifestUrl),
            sourceUrl: '',
          });
        } else {
          const info = detectListSource(c.sourceUrl || c.listUrl || c.manifestUrl);
          if (info.kind !== requestedKind) throw new Error('List source type does not match URL');
          folder.catalogs.push({
            ...base,
            sourceKind: info.kind,
            manifestUrl: '',
            sourceUrl: info.sourceUrl,
          });
        }
      } catch {
        // Ignore invalid catalog sources in generated configs.
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
  const catalogs = [
    { type: 'movie', id: 'odin-folders', name: 'Folders' },
  ];
  if (cfg.exposeChildCatalogs) {
    for (const folder of cfg.folders) {
      for (const cat of folder.catalogs) {
        catalogs.push({
          type: cat.type,
          id: childCatalogId(folder, cat),
          name: `${folder.name} • ${cat.name}`,
        });
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
    if (shape === 'landscape' && out.background) out.poster = out.background;
    if (cat.image && !out.poster) out.poster = cat.image;
    return out;
  });
}

async function fetchSourceCatalog(cat) {
  if (Array.isArray(cat.snapshotMetas) && cat.snapshotMetas.length) {
    return transformCatalogMetas(cat.snapshotMetas, cat);
  }
  if ((cat.sourceKind || 'addon') === 'addon') {
    const base = addonBaseFromManifest(cat.manifestUrl);
    const url = `${base}/catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(cat.catalogId)}.json`;
    const json = await safeFetchJson(url);
    return transformCatalogMetas(json?.metas, cat);
  }
  const info = detectListSource(cat.sourceUrl);
  const json = await fetchListSource(info, CATALOG_LIMIT * 3);
  const metas = json.metas.filter((m) => m.type === cat.type).slice(0, CATALOG_LIMIT);
  return transformCatalogMetas(metas, cat);
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


import { readFileSync } from 'node:fs';
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
    if (req.method === 'GET' && url.pathname === '/api/source-status') {
      sendJson(res, 200, {
        tmdb: sourceCredentials('tmdb'),
        trakt: sourceCredentials('trakt'),
        mdblist: sourceCredentials('mdblist'),
        browserCredentials: true,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/inspect-list') {
      const body = JSON.parse(await readBody(req) || '{}');
      const input = String(body.url || '').trim();
      if (!input) return sendJson(res, 400, { error: 'List URL is required' });
      const supplied = body.credentials && typeof body.credentials === 'object' ? body.credentials : {};
      const credentials = {
        ...envCredentials,
        tmdbBearerToken: String(supplied.tmdbBearerToken || envCredentials.tmdbBearerToken || ''),
        tmdbApiKey: String(supplied.tmdbApiKey || envCredentials.tmdbApiKey || ''),
        traktClientId: String(supplied.traktClientId || envCredentials.traktClientId || ''),
        mdblistApiKey: String(supplied.mdblistApiKey || envCredentials.mdblistApiKey || ''),
      };
      const result = await credentialContext.run(credentials, () => inspectList(input));
      sendJson(res, 200, result);
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
      sendJson(res, 200, {
        meta: {
          ...folderCard(folder),
          videos,
        },
      }, { 'cache-control': 'public, max-age=180' });
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
