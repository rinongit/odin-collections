import http from 'node:http';
import { spawn } from 'node:child_process';
import { createDirectSync } from './direct-sync.mjs';
import { createMultiUserBridge } from './multiuser.mjs';
import { createPublicProfilePortal } from './public-portal.mjs';

const PORT = Number(process.env.PORT || 10000);
const CHILD_PORT = PORT + 1;
const BRIDGE_KEY = process.env.BRIDGE_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!BRIDGE_KEY || !ADMIN_KEY) {
  console.error('Missing BRIDGE_KEY or ADMIN_KEY');
  process.exit(1);
}

const child = spawn(process.execPath, ['server-path.mjs'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(CHILD_PORT) },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  console.error(`server-path exited (${code ?? signal ?? 'unknown'})`);
  process.exit(code ?? 1);
});

const directSync = await createDirectSync();
const multiUser = await createMultiUserBridge();
const publicPortal = await createPublicProfilePortal();

function neutralizeWebsiteText(body) {
  return String(body)
    .replaceAll('Odin Trakt Bridge', 'Jellyfin Client')
    .replaceAll('Trakt → Odin Direct Sync', 'Trakt → Jellyfin Client Sync')
    .replaceAll('Odin/AIOStreams', 'Jellyfin Client')
    .replaceAll('AIOStreams/Jellyfin', 'Jellyfin Client')
    .replaceAll('AIOStreams Jellyfin', 'Jellyfin')
    .replaceAll('AIOStreams', 'Jellyfin Client')
    .replaceAll('Odin', 'Jellyfin Client');
}

function websiteResponse(res) {
  let isHtml = false;
  return new Proxy(res, {
    get(target, prop) {
      if (prop === 'writeHead') {
        return (statusCode, statusMessageOrHeaders, maybeHeaders) => {
          const headers = typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null
            ? statusMessageOrHeaders
            : maybeHeaders;
          const contentType = headers?.['content-type'] || headers?.['Content-Type'] || '';
          isHtml = String(contentType).includes('text/html');
          if (typeof statusMessageOrHeaders === 'string') {
            return target.writeHead(statusCode, statusMessageOrHeaders, maybeHeaders);
          }
          return target.writeHead(statusCode, statusMessageOrHeaders);
        };
      }
      if (prop === 'end') {
        return (chunk, encoding, callback) => {
          if (isHtml && chunk != null) {
            const wasBuffer = Buffer.isBuffer(chunk);
            const text = neutralizeWebsiteText(wasBuffer ? chunk.toString('utf8') : chunk);
            if (!target.headersSent) target.removeHeader('content-length');
            chunk = wasBuffer ? Buffer.from(text, 'utf8') : text;
          }
          return target.end(chunk, encoding, callback);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function rewrite(req) {
  const publicUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const legacy =
    publicUrl.pathname === '/manifest.json' ||
    publicUrl.pathname === '/watch_state/pull.json' ||
    publicUrl.pathname.startsWith('/watch_state/push/');

  if (!legacy) return { path: req.url, legacy: false, authorized: true };

  const authorized = publicUrl.searchParams.get('bridge_key') === BRIDGE_KEY;
  if (!authorized) return { path: req.url, legacy: true, authorized: false };

  publicUrl.searchParams.delete('bridge_key');
  const qs = publicUrl.searchParams.toString();
  return {
    path: `/${BRIDGE_KEY}${publicUrl.pathname}${qs ? `?${qs}` : ''}`,
    legacy: true,
    authorized: true,
  };
}

function shouldInjectDirectSyncLink(req, upstreamRes) {
  if (req.method !== 'GET') return false;
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname !== '/setup' || u.searchParams.get('key') !== ADMIN_KEY) return false;
  return String(upstreamRes.headers['content-type'] || '').includes('text/html');
}

function proxy(req, res) {
  const rewritten = rewrite(req);
  if (rewritten.legacy && !rewritten.authorized) {
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify({ error: 'invalid bridge key' }));
  }

  const originalHost = req.headers['x-forwarded-host'] || req.headers.host;
  const originalProto = req.headers['x-forwarded-proto'] || 'https';
  const headers = {
    ...req.headers,
    host: `127.0.0.1:${CHILD_PORT}`,
    'x-forwarded-host': originalHost,
    'x-forwarded-proto': originalProto,
  };

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: CHILD_PORT,
      method: req.method,
      path: rewritten.path,
      headers,
    },
    (upstreamRes) => {
      if (!shouldInjectDirectSyncLink(req, upstreamRes)) {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        const card = `<div class="box"><h3>Trakt → Jellyfin Client Sync</h3><p>Use this when the Jellyfin server has watch-state reading disabled. It writes Trakt progress and watched state directly through the Jellyfin API.</p><a href="/direct-sync?key=${encodeURIComponent(ADMIN_KEY)}">Configure direct sync</a></div><div class="box"><h3>Extra users</h3><p>Create isolated Trakt + Jellyfin profiles for friends without affecting your account.</p><a href="/profiles?key=${encodeURIComponent(ADMIN_KEY)}">Manage bridge users</a></div><div class="box"><h3>Public signup</h3><p>The public landing page lets anyone create their own isolated profile using their own Trakt app and Jellyfin credentials.</p><a href="/public">Open public portal</a></div>`;
        body = body.includes('</body>') ? body.replace('</body>', `${card}</body>`) : `${body}${card}`;
        body = neutralizeWebsiteText(body);
        const outHeaders = { ...upstreamRes.headers };
        delete outHeaders['content-length'];
        delete outHeaders['content-encoding'];
        outHeaders['cache-control'] = 'no-store';
        res.writeHead(upstreamRes.statusCode || 200, outHeaders);
        res.end(body);
      });
    }
  );

  upstream.on('error', (err) => {
    console.error('compat proxy:', err.message);
    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'bridge starting' }));
  });

  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  try {
    const branded = websiteResponse(res);
    if (await publicPortal.handle(req, branded)) return;
    if (await multiUser.handle(req, branded)) return;
    if (await directSync.handle(req, res)) return;
    proxy(req, res);
  } catch (err) {
    console.error('compat:', err?.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Trakt bridge + private owner sync + public Jellyfin Client portal listening on ${PORT}`);
});
