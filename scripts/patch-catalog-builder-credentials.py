from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
server = root / 'catalog-builder' / 'server.mjs'
ui = root / 'catalog-builder' / 'configure.html'
pkg = root / 'catalog-builder' / 'package.json'


def rep(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f'Patch anchor not found: {label}')
    return text.replace(old, new, 1)

s = server.read_text()
s = rep(s, "import { createClient } from 'redis';\n", "", 'remove redis import')

old_store = """const REDIS_URL = process.env.REDIS_URL || '';
const credentialContext = new AsyncLocalStorage();
const envCredentials = {
  tmdbBearerToken: TMDB_BEARER_TOKEN,
  tmdbApiKey: TMDB_API_KEY,
  traktClientId: TRAKT_CLIENT_ID,
  mdblistApiKey: MDBLIST_API_KEY,
};
let redis = null;
if (REDIS_URL) {
  redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('Credential store Redis:', e.message));
  await redis.connect();
}
const credKey = (id) => `cb:cred:${id}`;
const hashToken = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const currentCredentials = () => credentialContext.getStore() || envCredentials;
async function loadCredentialProfile(id) {
  if (!redis || !/^[a-f0-9]{32}$/.test(String(id || ''))) return null;
  const raw = await redis.get(credKey(id));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function effectiveCredentials(profileId) {
  const profile = await loadCredentialProfile(profileId);
  return { ...envCredentials, ...(profile?.credentials || {}) };
}
async function saveCredentialProfile(payload) {
  if (!redis) throw new Error('Credential storage is not configured on this server');
  let profileId = String(payload?.profileId || '');
  let editToken = String(payload?.editToken || '');
  let existing = null;
  if (profileId) {
    existing = await loadCredentialProfile(profileId);
    if (!existing) throw new Error('Credential profile was not found');
    if (!editToken || hashToken(editToken) !== existing.editHash) throw new Error('Credential profile edit token is invalid');
  } else {
    profileId = crypto.randomBytes(16).toString('hex');
    editToken = crypto.randomBytes(24).toString('base64url');
  }
  const next = { ...(existing?.credentials || {}) };
  for (const key of ['tmdbBearerToken','tmdbApiKey','traktClientId','mdblistApiKey']) {
    const value = String(payload?.[key] || '').trim();
    if (value) next[key] = value;
  }
  if (!Object.values(next).some(Boolean)) throw new Error('Enter at least one API credential');
  await redis.set(credKey(profileId), JSON.stringify({ editHash: hashToken(editToken), credentials: next }));
  return { profileId, editToken };
}
"""
new_store = """const credentialContext = new AsyncLocalStorage();
const envCredentials = {
  tmdbBearerToken: TMDB_BEARER_TOKEN,
  tmdbApiKey: TMDB_API_KEY,
  traktClientId: TRAKT_CLIENT_ID,
  mdblistApiKey: MDBLIST_API_KEY,
};
const currentCredentials = () => credentialContext.getStore() || envCredentials;
"""
s = rep(s, old_store, new_store, 'browser credential context')

# Accept Trakt image host values returned without a scheme.
old_first = """function firstImage(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : undefined;"""
new_first = """function firstImage(value) {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const x = value.trim();
    if (/^https?:\/\//i.test(x)) return x;
    if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(x)) return `https://${x}`;
    return undefined;
  }"""
s = rep(s, old_first, new_first, 'scheme-less images')

old_return = """  return {
    sourceKind: info.kind,
    sourceUrl: info.sourceUrl,
    name: result.name,
    description: result.description,
    catalogs,
  };"""
new_return = """  return {
    sourceKind: info.kind,
    sourceUrl: info.sourceUrl,
    name: result.name,
    description: result.description,
    catalogs,
    metas: result.metas,
  };"""
s = rep(s, old_return, new_return, 'inspect list metas')

s = rep(s, "    credentialProfileId: /^[a-f0-9]{32}$/.test(String(cfg.credentialProfileId || '')) ? String(cfg.credentialProfileId) : '',\n", "", 'remove profile from config')

old_base = """        const base = {
          id: slug(c.id || c.catalogId || c.name),
          name: String(c.name || c.catalogName || c.catalogId || 'Catalog').slice(0, 120),
          type: ['movie', 'series', 'anime'].includes(c.type) ? c.type : String(c.type || 'movie').slice(0, 40),
          catalogId: String(c.catalogId || c.id || '').slice(0, 160),
          image: String(c.image || '').slice(0, 2000),
          posterShape: ['source', 'poster', 'landscape', 'square'].includes(c.posterShape) ? c.posterShape : 'source',
        };"""
new_base = """        const type = ['movie', 'series', 'anime'].includes(c.type) ? c.type : String(c.type || 'movie').slice(0, 40);
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
        };"""
s = rep(s, old_base, new_base, 'snapshot sanitization')

old_transform = """    if (shape !== 'source') out.posterShape = shape;
    if (cat.image && !out.poster) out.poster = cat.image;
    return out;"""
new_transform = """    if (shape !== 'source') out.posterShape = shape;
    if (shape === 'landscape' && out.background) out.poster = out.background;
    if (cat.image && !out.poster) out.poster = cat.image;
    return out;"""
s = rep(s, old_transform, new_transform, 'landscape artwork')

old_fetch_source = """async function fetchSourceCatalog(cat) {
  if ((cat.sourceKind || 'addon') === 'addon') {"""
new_fetch_source = """async function fetchSourceCatalog(cat) {
  if (Array.isArray(cat.snapshotMetas) && cat.snapshotMetas.length) {
    return transformCatalogMetas(cat.snapshotMetas, cat);
  }
  if ((cat.sourceKind || 'addon') === 'addon') {"""
s = rep(s, old_fetch_source, new_fetch_source, 'snapshot source')

old_routes = """    if (req.method === 'GET' && url.pathname === '/api/source-status') {
      const credentials = await effectiveCredentials(url.searchParams.get('profile') || '');
      const status = credentialContext.run(credentials, () => ({
        tmdb: sourceCredentials('tmdb'),
        trakt: sourceCredentials('trakt'),
        mdblist: sourceCredentials('mdblist'),
        credentialStorage: Boolean(redis),
      }));
      sendJson(res, 200, status);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/credentials') {
      const body = await readBody(req);
      sendJson(res, 200, await saveCredentialProfile(JSON.parse(body || '{}')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/inspect-list') {
      const input = url.searchParams.get('url');
      if (!input) return sendJson(res, 400, { error: 'List URL is required' });
      const credentials = await effectiveCredentials(url.searchParams.get('profile') || '');
      const result = await credentialContext.run(credentials, () => inspectList(input));
      sendJson(res, 200, result);
      return;
    }"""
new_routes = """    if (req.method === 'GET' && url.pathname === '/api/source-status') {
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
    }"""
s = rep(s, old_routes, new_routes, 'browser inspect-list route')

s = rep(s, """      const credentials = await effectiveCredentials(cfg.credentialProfileId);
      const videos = await credentialContext.run(credentials, () => folderVideos(folder));""", "      const videos = await folderVideos(folder);", 'folder snapshot runtime')
s = rep(s, """        const credentials = await effectiveCredentials(cfg.credentialProfileId);
        const metas = await credentialContext.run(credentials, () => fetchSourceCatalog(found.cat));""", "        const metas = await fetchSourceCatalog(found.cat);", 'catalog snapshot runtime')
server.write_text(s)

h = ui.read_text()
h = rep(h, "Saved server-side under a private credential profile. Raw keys are never added to the generated addon URL.", "Keys stay in this browser and are sent only when you read/refresh a list. Imported items are embedded in the generated addon; raw keys are never added to its URL.", 'credential description')
h = h.replace('>Save credentials</button><button class="btn" id="forgetCredentials">Forget this browser\'s profile</button>', '>Save keys in this browser</button><button class="btn" id="forgetCredentials">Clear saved keys</button>')

old_state = """let state={name:'Odin Folders',description:'Custom folder and catalog addon for AIOStreams and Odin.',exposeChildCatalogs:true,credentialProfileId:'',folders:[]};
let credentialEditor={};try{credentialEditor=JSON.parse(localStorage.getItem('odinCatalogCredentialEditor')||'{}')||{}}catch{}if(credentialEditor.profileId)state.credentialProfileId=credentialEditor.profileId;"""
new_state = """let state={name:'Odin Folders',description:'Custom folder and catalog addon for AIOStreams and Odin.',exposeChildCatalogs:true,folders:[]};
let apiCredentials={tmdbBearerToken:'',tmdbApiKey:'',traktClientId:'',mdblistApiKey:''};
try{apiCredentials={...apiCredentials,...(JSON.parse(localStorage.getItem('odinCatalogApiCredentials')||'{}')||{})}}catch{}"""
h = rep(h, old_state, new_state, 'browser credential state')

old_inspect = "fetch('/api/inspect-list?url='+encodeURIComponent(url)+(state.credentialProfileId?'&profile='+encodeURIComponent(state.credentialProfileId):''))"
new_inspect = "fetch('/api/inspect-list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,credentials:apiCredentials})})"
h = rep(h, old_inspect, new_inspect, 'list POST credentials')

old_add = """state.folders[fi].catalogs.push({id:uid(),name:c.name||j.name,type:c.type||'movie',catalogId:c.id||'',sourceKind:j.sourceKind,manifestUrl:'',sourceUrl:j.sourceUrl,image:'',posterShape:sh,enabled:true})"""
new_add = """state.folders[fi].catalogs.push({id:uid(),name:c.name||j.name,type:c.type||'movie',catalogId:c.id||'',sourceKind:j.sourceKind,manifestUrl:'',sourceUrl:j.sourceUrl,image:'',posterShape:sh,enabled:true,snapshotMetas:(Array.isArray(j.metas)?j.metas:[]).filter(m=>m&&m.type===c.type)})"""
h = rep(h, old_add, new_add, 'embed list snapshot')

old_status = """async function loadSourceStatus(){try{const q=state.credentialProfileId?'?profile='+encodeURIComponent(state.credentialProfileId):'';const r=await fetch('/api/source-status'+q);const j=await r.json();$('#sourceStatus').innerHTML=['tmdb','trakt','mdblist'].map(k=>`<span class=\"pill ${j[k]?'on':'off'}\">${k.toUpperCase()}: ${j[k]?'ready':'needs key'}</span>`).join('');$('#credentialProfile').textContent=state.credentialProfileId?'Credential profile connected: '+state.credentialProfileId.slice(0,8)+'…':(j.credentialStorage?'No credential profile saved yet.':'Credential storage is unavailable on this server.')}catch{}}"""
new_status = """async function loadSourceStatus(){const ready={tmdb:Boolean(apiCredentials.tmdbBearerToken||apiCredentials.tmdbApiKey),trakt:Boolean(apiCredentials.traktClientId),mdblist:Boolean(apiCredentials.mdblistApiKey)};$('#sourceStatus').innerHTML=['tmdb','trakt','mdblist'].map(k=>`<span class=\"pill ${ready[k]?'on':'off'}\">${k.toUpperCase()}: ${ready[k]?'ready':'needs key'}</span>`).join('');$('#credentialProfile').textContent='Keys are stored only in this browser. Imported lists become snapshots inside the generated addon.'}"""
h = rep(h, old_status, new_status, 'local credential status')

old_handlers = """$('#saveCredentials').onclick=async()=>{const st=$('#credentialStatus');st.textContent='Saving…';try{const body={profileId:credentialEditor.profileId||'',editToken:credentialEditor.editToken||'',tmdbBearerToken:$('#tmdbBearer').value.trim(),tmdbApiKey:$('#tmdbKey').value.trim(),traktClientId:$('#traktClient').value.trim(),mdblistApiKey:$('#mdblistKey').value.trim()};const r=await fetch('/api/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||'Failed');credentialEditor={profileId:j.profileId,editToken:j.editToken};localStorage.setItem('odinCatalogCredentialEditor',JSON.stringify(credentialEditor));state.credentialProfileId=j.profileId;['#tmdbBearer','#tmdbKey','#traktClient','#mdblistKey'].forEach(x=>$(x).value='');st.innerHTML='<span class=\"ok\">Saved securely</span>';await loadSourceStatus()}catch(e){st.innerHTML='<span class=\"err\">'+esc(e.message)+'</span>'}};
$('#forgetCredentials').onclick=()=>{credentialEditor={};localStorage.removeItem('odinCatalogCredentialEditor');state.credentialProfileId='';$('#credentialStatus').textContent='Browser link cleared';loadSourceStatus()};"""
new_handlers = """$('#saveCredentials').onclick=()=>{apiCredentials={tmdbBearerToken:$('#tmdbBearer').value.trim(),tmdbApiKey:$('#tmdbKey').value.trim(),traktClientId:$('#traktClient').value.trim(),mdblistApiKey:$('#mdblistKey').value.trim()};localStorage.setItem('odinCatalogApiCredentials',JSON.stringify(apiCredentials));$('#credentialStatus').innerHTML='<span class=\"ok\">Saved in this browser</span>';loadSourceStatus()};
$('#forgetCredentials').onclick=()=>{apiCredentials={tmdbBearerToken:'',tmdbApiKey:'',traktClientId:'',mdblistApiKey:''};localStorage.removeItem('odinCatalogApiCredentials');$('#tmdbBearer').value='';$('#tmdbKey').value='';$('#traktClient').value='';$('#mdblistKey').value='';$('#credentialStatus').textContent='Saved keys cleared';loadSourceStatus()};"""
h = rep(h, old_handlers, new_handlers, 'local save handlers')

h = h.replace("state=JSON.parse(await e.target.files[0].text());if(!state.credentialProfileId&&credentialEditor.profileId)state.credentialProfileId=credentialEditor.profileId;render();loadSourceStatus()", "state=JSON.parse(await e.target.files[0].text());render();loadSourceStatus()")
h = h.replace("exposeChildCatalogs:true,credentialProfileId:state.credentialProfileId||'',folders:[", "exposeChildCatalogs:true,folders:[")

old_init = "state.folders=[newFolder('My Folder')];render();loadSourceStatus();"
new_init = """state.folders=[newFolder('My Folder')];
$('#tmdbBearer').value=apiCredentials.tmdbBearerToken||'';
$('#tmdbKey').value=apiCredentials.tmdbApiKey||'';
$('#traktClient').value=apiCredentials.traktClientId||'';
$('#mdblistKey').value=apiCredentials.mdblistApiKey||'';
render();loadSourceStatus();"""
h = rep(h, old_init, new_init, 'credential input init')
ui.write_text(h)

p = json.loads(pkg.read_text())
p.get('dependencies', {}).pop('redis', None)
if not p.get('dependencies'):
    p.pop('dependencies', None)
pkg.write_text(json.dumps(p, indent=2) + '\n')
print('Browser credentials + embedded list snapshots patch applied')
