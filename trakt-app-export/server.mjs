import http from 'node:http';
import { createClient } from 'redis';

const PORT = Number(process.env.PORT || 8080);
const REDIS_URL = process.env.REDIS_URL;
const MIGRATION_KEY = String(process.env.MIGRATION_KEY || '');
const PUBLIC_BASE = process.env.SOURCE_PUBLIC_URL || '';

if (!REDIS_URL || !MIGRATION_KEY) {
  console.error('REDIS_URL and MIGRATION_KEY are required');
  process.exit(1);
}

const redis = createClient({ url: REDIS_URL });
redis.on('error', (e) => console.error('Redis:', e.message));
await redis.connect();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (u.pathname !== '/export' || req.method !== 'GET') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  if (String(req.headers.authorization || '') !== `Bearer ${MIGRATION_KEY}`) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'forbidden' }));
  }
  const [clientId, clientSecret] = await redis.mGet(['trakt:client_id', 'trakt:client_secret']);
  if (!clientId || !clientSecret) {
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Trakt app not configured' }));
  }
  const redirectUri = PUBLIC_BASE ? `${PUBLIC_BASE.replace(/\/$/, '')}/oauth/callback` : '';
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify({ clientId, clientSecret, redirectUri }));
});

server.listen(PORT, '0.0.0.0', () => console.log(`migration service listening on ${PORT}`));
