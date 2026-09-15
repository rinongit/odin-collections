import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 10000);
const CHILD_PORT = PORT + 1;
const BRIDGE_KEY = process.env.BRIDGE_KEY;

if (!BRIDGE_KEY) {
  console.error('Missing BRIDGE_KEY');
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

const server = http.createServer((req, res) => {
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
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
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
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Odin Trakt compatibility proxy listening on ${PORT}`);
});
