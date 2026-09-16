import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ENC_SECRET = process.env.MDBLIST_ENCRYPTION_KEY || ADMIN_KEY;
const PROFILE_LIMIT = Math.max(10, Math.min(5000, Number(process.env.MDBLIST_PROFILE_LIMIT || 250)));
const CREATE_LIMIT = Math.max(1, Math.min(20, Number(process.env.MDBLIST_PROFILE_CREATE_PER_HOUR || 3)));
const CATALOG_PAGE_SIZE = Math.max(20, Math.min(250, Number(process.env.MDBLIST_CATALOG_PAGE_SIZE || 100)));
const CACHE_SECONDS = Math.max(60, Math.min(3600, Number(process.env.MDBLIST_CACHE_SECONDS || 600)));
const API = 'https://api.mdblist.com';

if (!REDIS_URL || !ENC_SECRET) throw new Error('MDBList portal requires REDIS_URL and encryption secret');

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeId = (v) => /^[a-f0-9]{12}$/.test(String(v || '')) ? String(v) : '';
const secret = (bytes = 24) => randomBytes(bytes).toString('hex');
const profileKey = (id) => `mdb:profile:${id}`;
const cacheKey = (id, suffix) => `mdb:cache:${id}:${suffix}`;
const encKey = createHash('sha256').update(ENC_SECRET).digest();

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
function decrypt(value) {
  const [ivS, tagS, dataS] = String(value || '').split('.');
  if (!ivS || !tagS || !dataS) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivS, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataS, 'base64url')), decipher.final()]).toString('utf8');
}
function secureEq(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
function sendHtml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(body);
}
function sendJson(res, status, body, cache = 'no-store') {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function redirect(res, location) {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}
async function readBody(req, max = 50_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String(req.socket?.remoteAddress || 'unknown');
}
function ipHash(req) { return createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 24); }
function base(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
async function loadJson(redis, key) {
  const raw = await redis.get(key);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function getProfile(redis, id) { return safeId(id) ? loadJson(redis, profileKey(id)) : null; }
async function mdbFetch(path, apiKey, params = {}) {
  const u = new URL(path, API);
  u.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'MDBListCatalogBridge/1.0' }, signal: AbortSignal.timeout(25_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`MDBList HTTP ${r.status}: ${text.slice(0, 180)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('MDBList returned invalid JSON'); }
  if (json && typeof json === 'object' && !Array.isArray(json) && json.response === false) throw new Error(`MDBList: ${json.error || 'request failed'}`);
  return { json, headers: r.headers };
}
async function validateKey(apiKey) {
  const { json } = await mdbFetch('/user', apiKey);
  if (!json || typeof json !== 'object') throw new Error('MDBList API key could not be verified');
  return json;
}
async function fetchLists(apiKey) {
  const { json } = await mdbFetch('/lists/user', apiKey, { sort: 'ranked' });
  const rows = Array.isArray(json) ? json : Array.isArray(json?.lists) ? json.lists : [];
  return rows.filter((x) => x && Number.isInteger(Number(x.id))).map((x) => ({
    id: Number(x.id), name: String(x.name || x.slug || `List ${x.id}`), slug: String(x.slug || ''),
    description: String(x.description || ''), mediatype: String(x.mediatype || '').toLowerCase(), items: Number(x.items || 0),
  }));
}
function publicType(mdbType) { return mdbType === 'show' || mdbType === 'series' ? 'series' : 'movie'; }
function listSupports(list, type) {
  const m = String(list.mediatype || '').toLowerCase();
  if (!m || m === 'mixed' || m === 'both' || m === 'all') return true;
  return publicType(m) === type;
}
async function fetchCatalogPage(apiKey, listId, type, skip) {
  const offset = Math.max(0, Number(skip || 0));
  const { json } = await mdbFetch(`/lists/${listId}/items`, apiKey, {
    limit: CATALOG_PAGE_SIZE,
    offset,
    unified: 'true',
    append_to_response: 'poster',
  });
  const arr = type === 'series' ? (json?.shows || []) : (json?.movies || []);
  return (Array.isArray(arr) ? arr : []).map((item) => {
    const imdb = String(item?.imdb_id || '');
    if (!/^tt\d+$/.test(imdb)) return null;
    const name = String(item?.title || imdb);
    const year = Number(item?.release_year || item?.year || 0);
    const poster = typeof item?.poster === 'string' ? item.poster : (typeof item?.poster_url === 'string' ? item.poster_url : undefined);
    return {
      id: imdb,
      type,
      name,
      ...(year > 1800 && year < 3000 ? { releaseInfo: String(year) } : {}),
      ...(poster ? { poster } : {}),
    };
  }).filter(Boolean);
}
function landingPage(notice = '', bad = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MDBList Catalog Bridge</title><style>body{font-family:system-ui;max-width:760px;margin:50px auto;padding:0 20px;line-height:1.5}.box{padding:18px;border:1px solid #ddd;border-radius:14px;margin:20px 0}input{width:100%;box-sizing:border-box;padding:11px;margin:6px 0 14px}button{padding:11px 18px;border:0;border-radius:9px;background:#2563eb;color:white;font-weight:700;cursor:pointer}.muted{color:#666}.bad{color:#b42318}.ok{color:#087f23}</style></head><body><h1>MDBList Catalog Bridge</h1><p>Create a private catalog manifest from your MDBList lists for your Jellyfin Client.</p>${notice ? `<p class="${bad ? 'bad' : 'ok'}"><strong>${esc(notice)}</strong></p>` : ''}<div class="box"><form method="post" action="/mdblist/create"><label>Profile name</label><input name="name" maxlength="50" placeholder="My MDBList" required><label>MDBList API key</label><input name="api_key" type="password" autocomplete="new-password" required><input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true"><button>Create profile</button></form></div><div class="box"><h3>How it works</h3><p>Your key is validated with MDBList, encrypted before storage, and never placed in the manifest URL. You can choose which of your lists appear as catalogs.</p><p class="muted">Keep the private setup URL safe. Deleting the profile removes its stored API key and configuration.</p></div></body></html>`;
}
function setupPage(req, p, lists) {
  const b = base(req);
  const key = encodeURIComponent(p.setupKey);
  const manifest = `${b}/mdb/u/${p.id}/${p.manifestKey}/manifest.json`;
  const selected = new Set((p.selected || []).map(Number));
  const cards = lists.map((x) => `<label style="display:block;padding:10px;border-bottom:1px solid #eee"><input style="width:auto;margin-right:10px" type="checkbox" name="list" value="${x.id}" ${selected.has(x.id) ? 'checked' : ''}><strong>${esc(x.name)}</strong> <span class="muted">(${esc(x.mediatype || 'mixed')}, ${Number(x.items || 0)} items)</span></label>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MDBList Catalog Bridge - ${esc(p.name)}</title><style>body{font-family:system-ui;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.45}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}button{padding:10px 16px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:650;margin:4px}.danger{background:#b42318}.muted{color:#666}code{word-break:break-all}</style></head><body><h1>${esc(p.name)} — MDBList Catalog Bridge</h1><div class="box"><h3>Manifest URL</h3><code>${esc(manifest)}</code><p class="muted">Use this private manifest in your Jellyfin Client.</p></div><div class="box"><h3>Choose lists</h3><form method="post" action="/mdb/u/${p.id}/lists?key=${key}">${cards || '<p>No MDBList lists were returned for this API key.</p>'}<p><button>Save selected lists</button></p></form></div><div class="box"><h3>Replace API key</h3><form method="post" action="/mdb/u/${p.id}/apikey?key=${key}"><input name="api_key" type="password" autocomplete="new-password" required><button>Save new key</button></form></div><div class="box"><form method="post" action="/mdb/u/${p.id}/delete?key=${key}" onsubmit="return confirm('Delete this profile?')"><button class="danger">Delete profile</button></form></div></body></html>`;
}

export async function createMDBListPortal() {
  const redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('MDBList portal Redis:', e.message));
  await redis.connect();

  async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = u.pathname;

    if ((path === '/mdblist' || path === '/mdblist/') && req.method === 'GET') {
      sendHtml(res, 200, landingPage()); return true;
    }
    if (path === '/mdblist/create' && req.method === 'POST') {
      const rateKey = `mdb:create:${ipHash(req)}`;
      const n = await redis.incr(rateKey); if (n === 1) await redis.expire(rateKey, 3600);
      if (n > CREATE_LIMIT) { sendHtml(res, 429, landingPage('Too many profiles created from this connection. Try again later.', true)); return true; }
      const count = await redis.sCard('mdb:profiles');
      if (count >= PROFILE_LIMIT) { sendHtml(res, 503, landingPage('Public MDBList profile capacity is full.', true)); return true; }
      const f = new URLSearchParams(await readBody(req));
      if (String(f.get('website') || '').trim()) { sendHtml(res, 400, landingPage('Could not create profile.', true)); return true; }
      const name = String(f.get('name') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      const apiKey = String(f.get('api_key') || '').trim();
      if (!name || !apiKey) { sendHtml(res, 400, landingPage('Profile name and API key are required.', true)); return true; }
      try {
        await validateKey(apiKey);
        const lists = await fetchLists(apiKey);
        const p = { id: secret(6), name, apiKey: encrypt(apiKey), setupKey: secret(24), manifestKey: secret(24), selected: lists.map((x) => x.id), createdAt: new Date().toISOString() };
        await redis.set(profileKey(p.id), JSON.stringify(p)); await redis.sAdd('mdb:profiles', p.id);
        redirect(res, `/mdb/u/${p.id}/setup?key=${encodeURIComponent(p.setupKey)}`); return true;
      } catch (e) {
        sendHtml(res, 400, landingPage((e?.message || String(e)).slice(0, 250), true)); return true;
      }
    }

    const m = path.match(/^\/mdb\/u\/([a-f0-9]{12})(?:\/(.*))?$/);
    if (!m) return false;
    const id = m[1], rest = m[2] || '';
    const p = await getProfile(redis, id);
    if (!p) { sendJson(res, 404, { error: 'profile not found' }); return true; }
    const setupOk = secureEq(u.searchParams.get('key'), p.setupKey);

    if (rest === 'setup' && req.method === 'GET') {
      if (!setupOk) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      try { sendHtml(res, 200, setupPage(req, p, await fetchLists(decrypt(p.apiKey)))); }
      catch (e) { sendHtml(res, 502, `<h1>MDBList error</h1><p>${esc((e?.message || String(e)).slice(0, 300))}</p>`); }
      return true;
    }
    if (rest === 'lists' && req.method === 'POST') {
      if (!setupOk) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      const f = new URLSearchParams(await readBody(req));
      const valid = new Set((await fetchLists(decrypt(p.apiKey))).map((x) => x.id));
      p.selected = f.getAll('list').map(Number).filter((x) => valid.has(x));
      await redis.set(profileKey(id), JSON.stringify(p));
      for await (const k of redis.scanIterator({ MATCH: `mdb:cache:${id}:*` })) await redis.del(k);
      redirect(res, `/mdb/u/${id}/setup?key=${encodeURIComponent(p.setupKey)}`); return true;
    }
    if (rest === 'apikey' && req.method === 'POST') {
      if (!setupOk) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      const f = new URLSearchParams(await readBody(req)); const apiKey = String(f.get('api_key') || '').trim();
      try {
        await validateKey(apiKey); const lists = await fetchLists(apiKey);
        p.apiKey = encrypt(apiKey); p.selected = lists.map((x) => x.id);
        await redis.set(profileKey(id), JSON.stringify(p));
        for await (const k of redis.scanIterator({ MATCH: `mdb:cache:${id}:*` })) await redis.del(k);
        redirect(res, `/mdb/u/${id}/setup?key=${encodeURIComponent(p.setupKey)}`);
      } catch (e) { sendHtml(res, 400, `<h1>Invalid MDBList key</h1><p>${esc((e?.message || String(e)).slice(0, 300))}</p>`); }
      return true;
    }
    if (rest === 'delete' && req.method === 'POST') {
      if (!setupOk) { sendHtml(res, 403, '<h1>Forbidden</h1>'); return true; }
      await redis.del(profileKey(id)); await redis.sRem('mdb:profiles', id);
      for await (const k of redis.scanIterator({ MATCH: `mdb:cache:${id}:*` })) await redis.del(k);
      redirect(res, '/mdblist'); return true;
    }

    const parts = rest.split('/');
    if (parts.length >= 2 && secureEq(parts[0], p.manifestKey)) {
      const sub = parts.slice(1).join('/');
      const apiKey = decrypt(p.apiKey);
      if (sub === 'manifest.json' && req.method === 'GET') {
        try {
          let lists = await loadJson(redis, cacheKey(id, 'lists'));
          if (!lists) { lists = await fetchLists(apiKey); await redis.set(cacheKey(id, 'lists'), JSON.stringify(lists), { EX: CACHE_SECONDS }); }
          const selected = new Set((p.selected || []).map(Number));
          const catalogs = [];
          for (const list of lists.filter((x) => selected.has(x.id))) {
            for (const type of ['movie', 'series']) if (listSupports(list, type)) catalogs.push({ type, id: `mdblist.${list.id}`, name: list.name, extra: [{ name: 'skip', isRequired: false }] });
          }
          sendJson(res, 200, { id: `community.mdblist.catalog.${id}`, version: '1.0.0', name: `MDBList Catalogs - ${p.name}`, description: 'Private MDBList catalogs.', resources: ['catalog'], types: ['movie', 'series'], catalogs, behaviorHints: { configurable: false, configurationRequired: false } }, `public, max-age=${CACHE_SECONDS}`);
        } catch (e) { sendJson(res, 502, { error: (e?.message || String(e)).slice(0, 300) }); }
        return true;
      }
      const cm = sub.match(/^catalog\/(movie|series)\/mdblist\.(\d+)\.json$/);
      if (cm && req.method === 'GET') {
        const type = cm[1], listId = Number(cm[2]), skip = Math.max(0, Number(u.searchParams.get('skip') || 0));
        if (!(p.selected || []).map(Number).includes(listId)) { sendJson(res, 404, { metas: [] }); return true; }
        const ck = cacheKey(id, `cat:${listId}:${type}:${skip}`);
        try {
          let metas = await loadJson(redis, ck);
          if (!metas) { metas = await fetchCatalogPage(apiKey, listId, type, skip); await redis.set(ck, JSON.stringify(metas), { EX: CACHE_SECONDS }); }
          sendJson(res, 200, { metas }, `public, max-age=${CACHE_SECONDS}`);
        } catch (e) { sendJson(res, 502, { error: (e?.message || String(e)).slice(0, 300), metas: [] }); }
        return true;
      }
    }
    sendJson(res, 404, { error: 'not found' }); return true;
  }
  return { handle };
}
