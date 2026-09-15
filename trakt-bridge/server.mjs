import http from 'node:http';
import { createClient } from 'redis';

const PORT = Number(process.env.PORT || 10000);
const REDIS_URL = process.env.REDIS_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const BRIDGE_KEY = process.env.BRIDGE_KEY;

if (!REDIS_URL || !ADMIN_KEY || !BRIDGE_KEY) {
  console.error('Missing REDIS_URL, ADMIN_KEY or BRIDGE_KEY');
  process.exit(1);
}

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err.message));
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

function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https')
    .toString()
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAdmin(url) {
  return url.searchParams.get('key') === ADMIN_KEY;
}

function isBridge(url) {
  return url.searchParams.get('bridge_key') === BRIDGE_KEY;
}

async function getCreds() {
  const [clientId, clientSecret] = await redis.mGet([
    'trakt:client_id',
    'trakt:client_secret',
  ]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function getStoredTokens() {
  const raw = await redis.get('trakt:tokens');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  await redis.set('trakt:tokens', JSON.stringify(tokens));
}

function expiryMs(tokens) {
  if (!tokens) return 0;
  const created = Number(tokens.created_at || 0) * 1000;
  const life = Number(tokens.expires_in || 0) * 1000;
  return created + life;
}

async function refreshTokens(req, force = false) {
  const creds = await getCreds();
  let tokens = await getStoredTokens();
  if (!creds || !tokens?.refresh_token) throw new Error('Trakt is not connected');
  if (!force && expiryMs(tokens) - Date.now() > 6 * 60 * 60 * 1000) {
    return tokens;
  }

  const resp = await fetch('https://auth.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      refresh_token: tokens.refresh_token,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: `${publicBase(req)}/oauth/callback`,
      grant_type: 'refresh_token',
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Trakt refresh failed: HTTP ${resp.status} ${text}`);
  }

  tokens = JSON.parse(text);
  await saveTokens(tokens);
  return tokens;
}

async function traktFetch(req, path, options = {}) {
  const creds = await getCreds();
  if (!creds) throw new Error('Trakt app credentials are not configured');

  let tokens = await refreshTokens(req, false);

  const send = async () =>
    fetch(`https://api.trakt.tv${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': creds.clientId,
        authorization: `Bearer ${tokens.access_token}`,
        ...(options.headers || {}),
      },
    });

  let resp = await send();
  if (resp.status === 401) {
    tokens = await refreshTokens(req, true);
    resp = await send();
  }
  return resp;
}

async function connectionInfo(req) {
  const tokens = await getStoredTokens();
  if (!tokens?.access_token) {
    return { connected: false, username: '', error: '' };
  }

  try {
    const tr = await traktFetch(req, '/users/settings');
    if (!tr.ok) {
      const text = await tr.text();
      return {
        connected: false,
        username: '',
        error: `Trakt verification failed: HTTP ${tr.status} ${text.slice(0, 160)}`,
      };
    }
    const settings = await tr.json();
    return {
      connected: true,
      username: settings?.user?.username || settings?.user?.name || '',
      error: '',
    };
  } catch (err) {
    return {
      connected: false,
      username: '',
      error: err?.message || String(err),
    };
  }
}

function normalizeIds(body) {
  const src = { ...(body.ids || {}) };
  const maybeImdb = [body.videoId, body.metaId].find(
    (v) => typeof v === 'string' && /^tt\d+$/.test(v)
  );
  if (!src.imdb && maybeImdb) src.imdb = maybeImdb;

  const out = {};
  if (src.imdb && /^tt\d+$/.test(String(src.imdb))) {
    out.imdb = String(src.imdb);
  }
  for (const k of ['tmdb', 'tvdb', 'trakt']) {
    const n = Number(src[k]);
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}

function targetFor(body) {
  const ids = normalizeIds(body);
  if (!Object.keys(ids).length) return null;

  const season = Number(body.season);
  const episode = Number(body.episode);
  const isEpisode =
    body.scope === 'episode' ||
    (Number.isInteger(season) &&
      season >= 0 &&
      Number.isInteger(episode) &&
      episode > 0);

  if (isEpisode) {
    return {
      kind: 'episode',
      ids,
      season,
      episode,
      payload: {
        show: { ids },
        episode: { season, number: episode },
      },
    };
  }

  return {
    kind: 'movie',
    ids,
    payload: { movie: { ids } },
  };
}

function progressFor(body) {
  const p = Number(body.positionMs);
  const d = Number(body.durationMs);
  if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0) return 0;
  return Math.max(0, Math.min(100, (p / d) * 100));
}

function keyFor(target) {
  const id =
    target.ids.imdb ||
    target.ids.tmdb ||
    target.ids.tvdb ||
    target.ids.trakt;
  return target.kind === 'episode'
    ? `${id}:s${target.season}e${target.episode}`
    : String(id);
}

function historyPayload(target, body, remove = false) {
  const watchedAt = new Date(
    (Number(body.at) || Math.floor(Date.now() / 1000)) * 1000
  ).toISOString();

  if (target.kind === 'movie') {
    return {
      movies: [
        {
          ids: target.ids,
          ...(remove ? {} : { watched_at: watchedAt }),
        },
      ],
    };
  }

  return {
    shows: [
      {
        ids: target.ids,
        seasons: [
          {
            number: target.season,
            episodes: [
              {
                number: target.episode,
                ...(remove ? {} : { watched_at: watchedAt }),
              },
            ],
          },
        ],
      },
    ],
  };
}

async function handlePush(req, res, url, type, videoId) {
  if (!isBridge(url)) {
    return json(res, 401, { error: 'invalid bridge key' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }

  body.videoId ||= videoId;
  const target = targetFor(body);
  if (!target) {
    return json(res, 200, {
      ok: true,
      ignored: 'no Trakt-compatible ids',
    });
  }

  const event = String(body.event || '');
  const k = keyFor(target);
  let path;
  let payload;

  if (['start', 'pause', 'stop'].includes(event)) {
    const progress = progressFor(body);
    path = `/scrobble/${event}`;
    payload = { ...target.payload, progress };

    if (event === 'stop' && progress >= 80) {
      await redis.set(`recent-watched-stop:${k}`, '1', { EX: 180 });
    }
  } else if (event === 'played') {
    const recentStop = await redis.get(`recent-watched-stop:${k}`);
    if (recentStop) {
      return json(res, 200, { ok: true, deduped: true });
    }
    path = '/sync/history';
    payload = historyPayload(target, body, false);
  } else if (event === 'unplayed') {
    path = '/sync/history/remove';
    payload = historyPayload(target, body, true);
  } else {
    return json(res, 200, {
      ok: true,
      ignored: `unsupported event ${event}`,
    });
  }

  try {
    const tr = await traktFetch(req, path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const text = await tr.text();

    if (!tr.ok) {
      console.error(`Trakt push failed ${tr.status}: ${text.slice(0, 300)}`);
      return json(
        res,
        tr.status === 401 || tr.status === 403 ? tr.status : 502,
        {
          error: `Trakt HTTP ${tr.status}`,
          details: text.slice(0, 500),
        }
      );
    }

    console.log(`Tracked ${event} ${type} ${videoId} -> Trakt ${tr.status}`);
    return json(res, 200, {
      ok: true,
      event,
      type,
      traktStatus: tr.status,
    });
  } catch (err) {
    console.error('Push error:', err);
    return json(res, 503, { error: err?.message || String(err) });
  }
}

async function startDeviceFlow() {
  const creds = await getCreds();
  if (!creds) throw new Error('Save the Trakt Client ID and Client Secret first');

  const tr = await fetch('https://api.trakt.tv/oauth/device/code', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.clientId,
    },
    body: JSON.stringify({ client_id: creds.clientId }),
  });

  const text = await tr.text();
  if (!tr.ok) {
    throw new Error(`Trakt device code failed: HTTP ${tr.status} ${text}`);
  }

  const device = JSON.parse(text);
  device.started_at = Math.floor(Date.now() / 1000);
  await redis.set('trakt:device', JSON.stringify(device), {
    EX: Math.max(60, Number(device.expires_in || 600)),
  });
  return device;
}

async function getDevice() {
  const raw = await redis.get('trakt:device');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function pollDeviceFlow() {
  const creds = await getCreds();
  const device = await getDevice();

  if (!creds) return { state: 'error', error: 'Trakt app credentials missing' };
  if (!device?.device_code) {
    return { state: 'idle', error: 'No active device login' };
  }

  const started = Number(device.started_at || 0);
  const expires = Number(device.expires_in || 600);
  if (started && Date.now() / 1000 > started + expires) {
    await redis.del('trakt:device');
    return { state: 'expired', error: 'Device code expired' };
  }

  const tr = await fetch('https://api.trakt.tv/oauth/device/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.clientId,
    },
    body: JSON.stringify({
      code: device.device_code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  });

  const text = await tr.text();

  if (tr.ok) {
    const tokens = JSON.parse(text);
    await saveTokens(tokens);
    await redis.del('trakt:device');
    console.log('Trakt device authorization completed');
    return { state: 'connected' };
  }

  if (tr.status === 400) return { state: 'pending' };
  if (tr.status === 429) return { state: 'pending', slowDown: true };
  if (tr.status === 410) {
    await redis.del('trakt:device');
    return { state: 'expired', error: 'Device code expired' };
  }
  if (tr.status === 418) {
    await redis.del('trakt:device');
    return { state: 'denied', error: 'Authorization denied in Trakt' };
  }

  return {
    state: 'error',
    error: `Trakt device token HTTP ${tr.status}: ${text.slice(0, 200)}`,
  };
}

function setupPage(req, info, hasCreds, device) {
  const base = publicBase(req);
  const admin = encodeURIComponent(ADMIN_KEY);
  const callback = `${base}/oauth/callback`;
  const manifest = `${base}/manifest.json?bridge_key=${encodeURIComponent(
    BRIDGE_KEY
  )}`;

  const deviceBlock =
    hasCreds && !info.connected
      ? device?.user_code
        ? `<div class="box"><h3>3. Connect Trakt</h3>
<p>Open <a href="${esc(
            device.verification_url || 'https://trakt.tv/activate'
          )}" target="_blank" rel="noreferrer"><strong>${esc(
            device.verification_url || 'https://trakt.tv/activate'
          )}</strong></a> and enter this code:</p>
<div class="code">${esc(device.user_code)}</div>
<p id="device-status" class="muted">Waiting for authorization…</p>
<script>
const key=${JSON.stringify(ADMIN_KEY)};
async function check(){
  try{
    const r=await fetch('/device/status?key='+encodeURIComponent(key),{cache:'no-store'});
    const j=await r.json();
    const el=document.getElementById('device-status');
    if(j.state==='connected'){ el.textContent='Connected! Reloading…'; location.reload(); return; }
    if(j.state==='pending'){ el.textContent='Waiting for authorization…'; }
    else if(j.error){ el.textContent=j.error; }
  }catch(e){}
  setTimeout(check,6000);
}
setTimeout(check,2500);
</script></div>`
        : `<div class="box"><h3>3. Connect Trakt</h3>
<form method="post" action="/device/start?key=${admin}">
<button type="submit">Start Trakt Device Login</button>
</form>
<p class="muted">This uses Trakt's device authorization flow and avoids redirect/callback issues.</p>
</div>`
      : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Odin Trakt Bridge</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.45;color:#171717}
code,input{font-family:ui-monospace,monospace}
input{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px}
button,a.button{display:inline-block;padding:10px 16px;border:0;border-radius:8px;background:#ed1c24;color:#fff;text-decoration:none;font-weight:650;cursor:pointer}
.ok{color:#087f23}.bad{color:#b42318}.muted{color:#666}.box{padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0}
code{word-break:break-all}.code{font:700 36px ui-monospace,monospace;letter-spacing:5px;margin:15px 0}
</style>
</head>
<body>
<h1>Odin Trakt Bridge</h1>
<p>Status: <strong class="${info.connected ? 'ok' : ''}">${
    info.connected
      ? `Connected${info.username ? ` as ${esc(info.username)}` : ''}`
      : hasCreds
        ? 'Trakt app configured — account not connected yet'
        : 'Setup required'
  }</strong></p>
${
  info.error
    ? `<p class="bad"><strong>Diagnostic:</strong> ${esc(info.error)}</p>`
    : ''
}
<div class="box">
<h3>1. Trakt API app</h3>
<p>Your existing Trakt app is fine. Keep this redirect URI configured:</p>
<p><code>${esc(callback)}</code></p>
</div>
<div class="box">
<h3>2. Trakt app credentials</h3>
<form method="post" action="/setup/credentials?key=${admin}">
<label>Client ID</label>
<input name="client_id" required autocomplete="off">
<label>Client Secret</label>
<input name="client_secret" required type="password" autocomplete="off">
<button type="submit">Save credentials</button>
</form>
</div>
${deviceBlock}
${
  info.connected
    ? `<div class="box"><h3>4. Add to AIOStreams</h3>
<p>Use this custom addon manifest URL:</p>
<p><code>${esc(manifest)}</code></p>
</div>`
    : ''
}
</body>
</html>`;
}

async function handler(req, res) {
  const url = new URL(req.url, publicBase(req));
  const path = url.pathname;

  if (path === '/healthz') {
    return json(res, 200, { ok: true });
  }

  if (path === '/') {
    return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
  }

  if (path === '/manifest.json') {
    if (!isBridge(url)) {
      return json(res, 401, { error: 'invalid bridge key' });
    }

    return json(res, 200, {
      id: 'community.odin.trakt.bridge',
      version: '1.1.0',
      name: 'Odin Trakt Bridge',
      description: 'Tracks Odin/AIOStreams Jellyfin playback in Trakt.',
      resources: [
        {
          name: 'watch_state',
          types: ['movie', 'series'],
        },
      ],
      types: ['movie', 'series'],
      catalogs: [],
      watchState: {
        version: 1,
        push: {
          events: ['start', 'pause', 'stop', 'played', 'unplayed'],
        },
      },
      behaviorHints: {
        configurable: false,
        configurationRequired: false,
      },
    });
  }

  if (path === '/setup' && req.method === 'GET') {
    if (!isAdmin(url)) return html(res, 403, '<h1>Forbidden</h1>');

    const creds = await getCreds();
    const info = await connectionInfo(req);
    const device = await getDevice();
    return html(res, 200, setupPage(req, info, !!creds, device));
  }

  if (path === '/setup/credentials' && req.method === 'POST') {
    if (!isAdmin(url)) return html(res, 403, '<h1>Forbidden</h1>');

    const form = new URLSearchParams(await readBody(req));
    const clientId = form.get('client_id')?.trim();
    const clientSecret = form.get('client_secret')?.trim();

    if (!clientId || !clientSecret) {
      return html(res, 400, '<h1>Missing client ID or secret</h1>');
    }

    await redis.mSet({
      'trakt:client_id': clientId,
      'trakt:client_secret': clientSecret,
    });
    await redis.del('trakt:tokens');
    await redis.del('trakt:device');

    console.log('Trakt app credentials saved');
    return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
  }

  if (path === '/device/start' && req.method === 'POST') {
    if (!isAdmin(url)) return html(res, 403, '<h1>Forbidden</h1>');

    try {
      await startDeviceFlow();
      return redirect(res, `/setup?key=${encodeURIComponent(ADMIN_KEY)}`);
    } catch (err) {
      console.error('Device login start failed:', err);
      return html(
        res,
        502,
        `<h1>Could not start Trakt device login</h1><pre>${esc(
          err?.message || String(err)
        )}</pre><p><a href="/setup?key=${encodeURIComponent(
          ADMIN_KEY
        )}">Back</a></p>`
      );
    }
  }

  if (path === '/device/status' && req.method === 'GET') {
    if (!isAdmin(url)) return json(res, 403, { error: 'forbidden' });

    const info = await connectionInfo(req);
    if (info.connected) {
      return json(res, 200, {
        state: 'connected',
        username: info.username,
      });
    }

    const state = await pollDeviceFlow();
    if (state.state === 'connected') {
      const verified = await connectionInfo(req);
      return json(res, 200, {
        state: verified.connected ? 'connected' : 'error',
        username: verified.username,
        error: verified.error || undefined,
      });
    }

    return json(res, 200, state);
  }

  if (path === '/oauth/callback' && req.method === 'GET') {
    return html(
      res,
      200,
      `<h1>Use Device Login</h1><p>The bridge now uses Trakt device authorization for reliability.</p><p><a href="/setup?key=${encodeURIComponent(
        ADMIN_KEY
      )}">Return to setup</a></p>`
    );
  }

  const m = path.match(
    /^\/watch_state\/push\/([^/]+)\/([^/]+)\.json$/
  );
  if (m && req.method === 'POST') {
    return handlePush(
      req,
      res,
      url,
      decodeURIComponent(m[1]),
      decodeURIComponent(m[2])
    );
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error('Request failed:', err);
    if (!res.headersSent) {
      json(res, 500, {
        error: 'internal error',
        details: err?.message || String(err),
      });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, '0.0.0.0', () =>
  console.log(`Odin Trakt Bridge listening on ${PORT}`)
);
