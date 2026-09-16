import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('PERMANENT_TRAKT_MIGRATION_RESULT')) {
  const marker = "setTimeout(() => void cleanupAbandoned().catch((e) => console.error('cleanup:', e.message)), 20_000).unref?.();";
  if (!source.includes(marker)) throw new Error('Trakt migration patch failed: timer marker');

  const runner = `
if (process.env.MIGRATE_TRAKT === '1') {
  setTimeout(async () => {
    const id = String(process.env.MIGRATE_PROFILE_ID || '').trim();
    const result = { profileId: id ? \`\${id.slice(0,4)}…\${id.slice(-4)}\` : '', appCopied: false, tokensCopied: false, connected: false };
    try {
      if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('invalid profile id');
      const [clientId, clientSecret, oldTokens] = await redis.mGet(['trakt:client_id', 'trakt:client_secret', 'trakt:tokens']);
      if (!clientId || !clientSecret) throw new Error('old Trakt app credentials not found');
      if (!oldTokens) throw new Error('old Trakt tokens not found');

      await redis.set(SHARED_TRAKT_KEY, JSON.stringify({ clientId, clientSecret }));
      result.appCopied = true;
      await redis.set(tokenKey(id), oldTokens);
      result.tokensCopied = true;
      await redis.del(pullKey(id)).catch(() => undefined);

      const r = await traktFetch(id, '/users/settings');
      result.httpStatus = r.status;
      result.connected = r.ok;
      if (!r.ok) {
        const text = await r.text();
        result.error = \`Trakt HTTP \${r.status}: \${text.slice(0, 160)}\`;
      } else {
        await r.text().catch(() => '');
      }
    } catch (e) {
      result.error = String(e?.message || e).slice(0, 300);
    }
    console.log('PERMANENT_TRAKT_MIGRATION_RESULT', JSON.stringify(result));
  }, 6000).unref?.();
}
`;

  source = source.replace(marker, `${runner}\n${marker}`);
}

await writeFile(file, source, 'utf8');
console.log('Applied one-time Trakt migration');
