import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const MAX_PUBLIC_PROFILES = Math.max(10, Math.min(5000, Number(process.env.PUBLIC_PROFILE_LIMIT || 250)));
const CREATE_LIMIT = Math.max(1, Math.min(20, Number(process.env.PUBLIC_PROFILE_CREATE_PER_HOUR || 3)));
const UNCONFIGURED_TTL_MS = 24 * 60 * 60 * 1000;

if (!REDIS_URL) throw new Error('Public profile portal requires REDIS_URL');

const profileKey = (id) => `mu:profile:${id}`;
const credsKey = (id) => `mu:trakt:creds:${id}`;
const tokenKey = (id) => `mu:trakt:tokens:${id}`;
const jfKey = (id) => `mu:jf:${id}`;
const pullKey = (id) => `mu:pull:${id}`;
const watchedKey = (id) => `mu:watched:${id}`;
const resumeKey = (id) => `mu:resume:${id}`;
const statusKey = (id) => `mu:status:${id}`;
const lockKey = (id) => `mu:lock:${id}`;
const safeId = (v) => /^[a-f0-9]{12}$/.test(String(v || '')) ? String(v) : '';
const secret = (bytes = 24) => randomBytes(bytes).toString('hex');
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}
function redirect(res, location) {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}
async function readBody(req, max = 20_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || 'unknown');
}
function ipHash(req) {
  return createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 24);
}
function secureEq(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
async function loadJson(redis, key) {
  const raw = await redis.get(key);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function deleteProfile(redis, id) {
  await redis.del([
    profileKey(id), credsKey(id), tokenKey(id), jfKey(id), pullKey(id),
    watchedKey(id), resumeKey(id), statusKey(id), lockKey(id),
  ]);
  await redis.sRem('mu:profiles', id);
}

export async function createPublicProfilePortal() {
  const redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('Public portal Redis:', e.message));
  await redis.connect();

  async function cleanupAbandoned() {
    const ids = await redis.sMembers('mu:profiles');
    const now = Date.now();
    for (const idRaw of ids) {
      const id = safeId(idRaw);
      if (!id) continue;
      const p = await loadJson(redis, profileKey(id));
      if (!p?.public) continue;
      const created = Date.parse(String(p.createdAt || ''));
      if (!Number.isFinite(created) || now - created < UNCONFIGURED_TTL_MS) continue;
      const [creds, tokens, jf] = await Promise.all([
        redis.exists(credsKey(id)), redis.exists(tokenKey(id)), redis.exists(jfKey(id)),
      ]);
      if (!creds && !tokens && !jf) await deleteProfile(redis, id);
    }
  }

  function landingPage(notice = '') {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odin Trakt Bridge</title><style>body{font-family:system-ui;max-width:720px;margin:50px auto;padding:0 20px;line-height:1.5}h1{margin-bottom:8px}.box{padding:18px;border:1px solid #ddd;border-radius:14px;margin:20px 0}input{width:100%;box-sizing:border-box;padding:11px;margin:6px 0 14px}button{padding:11px 18px;border:0;border-radius:9px;background:#ed1c24;color:#fff;font-weight:700;cursor:pointer}.muted{color:#666}.ok{color:#087f23}.bad{color:#b42318}code{word-break:break-all}</style></head><body><h1>Odin Trakt Bridge</h1><p>Create your own private bridge profile for Trakt ↔ Odin/AIOStreams sync.</p>${notice ? `<p class="ok"><strong>${esc(notice)}</strong></p>` : ''}<div class="box"><h3>Create your private profile</h3><form method="post" action="/public/create"><label>Profile name</label><input name="name" maxlength="50" placeholder="My Odin" required><input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true"><button>Create profile</button></form></div><div class="box"><h3>What you need</h3><p>You will use <strong>your own Trakt API app</strong> and your own AIOStreams/Jellyfin login. No other user's Trakt credentials or watch history are shared with your profile.</p><p class="muted">After creating the profile, the next page shows your exact Trakt redirect URI, private setup controls, and AIOStreams manifest URL.</p></div><p class="muted">Public profiles that are created but never configured are automatically removed after 24 hours. Keep your private setup URL safe.</p></body></html>`;
  }

  async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = u.pathname;

    if ((path === '/' || path === '/public' || path === '/join') && req.method === 'GET') {
      sendHtml(res, 200, landingPage());
      return true;
    }

    if (path === '/public/create' && req.method === 'POST') {
      const rateKey = `mu:public:create:${ipHash(req)}`;
      const n = await redis.incr(rateKey);
      if (n === 1) await redis.expire(rateKey, 3600);
      if (n > CREATE_LIMIT) {
        sendHtml(res, 429, landingPage('Too many profiles were created from this connection. Try again later.'));
        return true;
      }
      const current = await redis.sCard('mu:profiles');
      if (current >= MAX_PUBLIC_PROFILES) {
        sendHtml(res, 503, landingPage('Public profile capacity is currently full.'));
        return true;
      }
      const f = new URLSearchParams(await readBody(req));
      if (String(f.get('website') || '').trim()) {
        sendHtml(res, 400, landingPage('Could not create profile.'));
        return true;
      }
      const name = String(f.get('name') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      if (!name) {
        sendHtml(res, 400, landingPage('Profile name is required.'));
        return true;
      }
      const profile = {
        id: secret(6),
        name,
        setupKey: secret(24),
        bridgeKey: secret(24),
        createdAt: new Date().toISOString(),
        public: true,
      };
      await redis.set(profileKey(profile.id), JSON.stringify(profile));
      await redis.sAdd('mu:profiles', profile.id);
      redirect(res, `/u/${profile.id}/setup?key=${encodeURIComponent(profile.setupKey)}`);
      return true;
    }

    const dm = path.match(/^\/u\/([a-f0-9]{12})\/delete$/);
    if (dm && req.method === 'POST') {
      const id = dm[1];
      const profile = await loadJson(redis, profileKey(id));
      if (!profile?.public || !secureEq(u.searchParams.get('key'), profile.setupKey)) {
        sendHtml(res, 403, '<h1>Forbidden</h1>');
        return true;
      }
      await deleteProfile(redis, id);
      redirect(res, '/public');
      return true;
    }

    return false;
  }

  setTimeout(() => void cleanupAbandoned().catch((e) => console.error('Public cleanup:', e.message)), 20_000).unref?.();
  setInterval(() => void cleanupAbandoned().catch((e) => console.error('Public cleanup:', e.message)), 60 * 60 * 1000).unref?.();

  return { handle, cleanupAbandoned };
}
