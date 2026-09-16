import { createClient } from 'redis';
import { startPublicProxy } from './jellyfin-proxy.mjs';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('REDIS_URL is required');

const publicPort = Number(process.env.PORT || 8080);
const childPort = publicPort + 1;

const redis = createClient({ url: REDIS_URL });
redis.on('error', (e) => console.error('Bootstrap Redis:', e.message));
await redis.connect();

try {
  const existing = await redis.get('jc:trakt:app');
  if (!existing) {
    const [clientId, clientSecret] = await redis.mGet(['trakt:client_id', 'trakt:client_secret']);
    if (clientId && clientSecret) {
      await redis.set('jc:trakt:app', JSON.stringify({ clientId, clientSecret }));
      console.log('Jellyfin Client Trakt app credentials initialized');
    }
  }
} finally {
  await redis.quit();
}

process.env.PORT = String(childPort);
await import('./server.mjs');
startPublicProxy({ port: publicPort, childPort });
