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
s = rep(s, "import crypto from 'node:crypto';", "import crypto from 'node:crypto';\nimport { AsyncLocalStorage } from 'node:async_hooks';\nimport { createClient } from 'redis';", 'imports')

anchor = "const MDBLIST_API_KEY = process.env.MDBLIST_API_KEY || '';"
insert = anchor + """
const REDIS_URL = process.env.REDIS_URL || '';
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
s = rep(s, anchor, insert, 'credential store')

old = """function sourceCredentials(kind) {
  if (kind === 'tmdb') return Boolean(TMDB_BEARER_TOKEN || TMDB_API_KEY);
  if (kind === 'trakt') return Boolean(TRAKT_CLIENT_ID);
  if (kind === 'mdblist') return Boolean(MDBLIST_API_KEY);
  return true;
}"""
new = """function sourceCredentials(kind) {
  const c = currentCredentials();
  if (kind === 'tmdb') return Boolean(c.tmdbBearerToken || c.tmdbApiKey);
  if (kind === 'trakt') return Boolean(c.traktClientId);
  if (kind === 'mdblist') return Boolean(c.mdblistApiKey);
  return true;
}"""
s = rep(s, old, new, 'source credentials')

s = rep(s, """async function tmdbFetch(path, params = {}) {
  requireSourceCredentials('tmdb');
  const headers = {};
  if (TMDB_BEARER_TOKEN) headers.authorization = `Bearer ${TMDB_BEARER_TOKEN}`;
  const query = { ...params };
  if (!TMDB_BEARER_TOKEN && TMDB_API_KEY) query.api_key = TMDB_API_KEY;""", """async function tmdbFetch(path, params = {}) {
  requireSourceCredentials('tmdb');
  const c = currentCredentials();
  const headers = {};
  if (c.tmdbBearerToken) headers.authorization = `Bearer ${c.tmdbBearerToken}`;
  const query = { ...params };
  if (!c.tmdbBearerToken && c.tmdbApiKey) query.api_key = c.tmdbApiKey;""", 'tmdb credentials')

s = rep(s, "'trakt-api-key': TRAKT_CLIENT_ID,", "'trakt-api-key': currentCredentials().traktClientId,", 'trakt credentials')
s = rep(s, "return safeFetchJson(withQuery(`https://api.mdblist.com${path}`, { ...params, apikey: MDBLIST_API_KEY }));", "return safeFetchJson(withQuery(`https://api.mdblist.com${path}`, { ...params, apikey: currentCredentials().mdblistApiKey }));", 'mdblist credentials')

s = rep(s, """    exposeChildCatalogs: cfg.exposeChildCatalogs !== false,
    folders: [],""", """    exposeChildCatalogs: cfg.exposeChildCatalogs !== false,
    credentialProfileId: /^[a-f0-9]{32}$/.test(String(cfg.credentialProfileId || '')) ? String(cfg.credentialProfileId) : '',
    folders: [],""", 'config profile')

old_routes = """    if (req.method === 'GET' && url.pathname === '/api/source-status') {
      sendJson(res, 200, {
        tmdb: sourceCredentials('tmdb'),
        trakt: sourceCredentials('trakt'),
        mdblist: sourceCredentials('mdblist'),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/inspect-list') {
      const input = url.searchParams.get('url');
      if (!input) return sendJson(res, 400, { error: 'List URL is required' });
      const result = await inspectList(input);
      sendJson(res, 200, result);
      return;
    }"""
new_routes = """    if (req.method === 'GET' && url.pathname === '/api/source-status') {
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
s = rep(s, old_routes, new_routes, 'api credential routes')
s = rep(s, "const videos = await folderVideos(folder);", "const credentials = await effectiveCredentials(cfg.credentialProfileId);\n      const videos = await credentialContext.run(credentials, () => folderVideos(folder));", 'folder credentials')
s = rep(s, "const metas = await fetchSourceCatalog(found.cat);", "const credentials = await effectiveCredentials(cfg.credentialProfileId);\n        const metas = await credentialContext.run(credentials, () => fetchSourceCatalog(found.cat));", 'catalog credentials')
server.write_text(s)

h = ui.read_text()
credential_html = """
<div class="importer">
  <strong>API credentials</strong><div class="small">Saved server-side under a private credential profile. Raw keys are never added to the generated addon URL.</div>
  <div class="grid3" style="margin-top:10px">
    <div class="field"><label>TMDB Read Access Token / Bearer Token</label><input id="tmdbBearer" type="password" autocomplete="off" placeholder="Optional if using TMDB API key" /></div>
    <div class="field"><label>TMDB API Key</label><input id="tmdbKey" type="password" autocomplete="off" placeholder="Optional if using bearer token" /></div>
    <div class="field"><label>Trakt Client ID</label><input id="traktClient" type="password" autocomplete="off" /></div>
    <div class="field"><label>MDBList API Key</label><input id="mdblistKey" type="password" autocomplete="off" /></div>
  </div>
  <div class="actions" style="margin-top:10px"><button class="btn primary" id="saveCredentials">Save credentials</button><button class="btn" id="forgetCredentials">Forget this browser's profile</button><span id="credentialStatus" class="small"></span></div>
  <div id="credentialProfile" class="small" style="margin-top:8px"></div>
</div>
"""
h = rep(h, "</div>\n<div class=\"importer\">\n  <strong>Import an addon</strong>", "</div>" + credential_html + "<div class=\"importer\">\n  <strong>Import an addon</strong>", 'credential html')

h = rep(h, "let state={name:'Odin Folders',description:'Custom folder and catalog addon for AIOStreams and Odin.',exposeChildCatalogs:true,folders:[]};", "let state={name:'Odin Folders',description:'Custom folder and catalog addon for AIOStreams and Odin.',exposeChildCatalogs:true,credentialProfileId:'',folders:[]};\nlet credentialEditor={};try{credentialEditor=JSON.parse(localStorage.getItem('odinCatalogCredentialEditor')||'{}')||{}}catch{}if(credentialEditor.profileId)state.credentialProfileId=credentialEditor.profileId;", 'ui state')

h = h.replace("fetch('/api/inspect-list?url='+encodeURIComponent(url))", "fetch('/api/inspect-list?url='+encodeURIComponent(url)+(state.credentialProfileId?'&profile='+encodeURIComponent(state.credentialProfileId):''))")

old_status = "async function loadSourceStatus(){try{const r=await fetch('/api/source-status');const j=await r.json();$('#sourceStatus').innerHTML=['tmdb','trakt','mdblist'].map(k=>`<span class=\"pill ${j[k]?'on':'off'}\">${k.toUpperCase()}: ${j[k]?'ready':'needs key'}</span>`).join('')}catch{}}"
new_status = "async function loadSourceStatus(){try{const q=state.credentialProfileId?'?profile='+encodeURIComponent(state.credentialProfileId):'';const r=await fetch('/api/source-status'+q);const j=await r.json();$('#sourceStatus').innerHTML=['tmdb','trakt','mdblist'].map(k=>`<span class=\"pill ${j[k]?'on':'off'}\">${k.toUpperCase()}: ${j[k]?'ready':'needs key'}</span>`).join('');$('#credentialProfile').textContent=state.credentialProfileId?'Credential profile connected: '+state.credentialProfileId.slice(0,8)+'…':(j.credentialStorage?'No credential profile saved yet.':'Credential storage is unavailable on this server.')}catch{}}"
h = rep(h, old_status, new_status, 'source status UI')

handlers = """$('#saveCredentials').onclick=async()=>{const st=$('#credentialStatus');st.textContent='Saving…';try{const body={profileId:credentialEditor.profileId||'',editToken:credentialEditor.editToken||'',tmdbBearerToken:$('#tmdbBearer').value.trim(),tmdbApiKey:$('#tmdbKey').value.trim(),traktClientId:$('#traktClient').value.trim(),mdblistApiKey:$('#mdblistKey').value.trim()};const r=await fetch('/api/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||'Failed');credentialEditor={profileId:j.profileId,editToken:j.editToken};localStorage.setItem('odinCatalogCredentialEditor',JSON.stringify(credentialEditor));state.credentialProfileId=j.profileId;['#tmdbBearer','#tmdbKey','#traktClient','#mdblistKey'].forEach(x=>$(x).value='');st.innerHTML='<span class="ok">Saved securely</span>';await loadSourceStatus()}catch(e){st.innerHTML='<span class="err">'+esc(e.message)+'</span>'}};
$('#forgetCredentials').onclick=()=>{credentialEditor={};localStorage.removeItem('odinCatalogCredentialEditor');state.credentialProfileId='';$('#credentialStatus').textContent='Browser link cleared';loadSourceStatus()};
"""
h = rep(h, "$('#generate').onclick=async()=>{", handlers + "$('#generate').onclick=async()=>{", 'credential handlers')
h = h.replace("state={name:'Odin Folders',description:'Custom folder and catalog addon for AIOStreams and Odin.',exposeChildCatalogs:true,folders:[", "state={name:'Odin Folders',description:'Custom folder and catalog addon for AIOStreams and Odin.',exposeChildCatalogs:true,credentialProfileId:state.credentialProfileId||'',folders:[")
h = h.replace("state=JSON.parse(await e.target.files[0].text());render()", "state=JSON.parse(await e.target.files[0].text());if(!state.credentialProfileId&&credentialEditor.profileId)state.credentialProfileId=credentialEditor.profileId;render();loadSourceStatus()")
ui.write_text(h)

p = json.loads(pkg.read_text())
p.setdefault('dependencies', {})['redis'] = '^5.0.0'
pkg.write_text(json.dumps(p, indent=2) + '\n')
print('Credential UI/backend patch applied')
