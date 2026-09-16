import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('PUBLIC_TRAKT_CLEANUP_RESULT')) {
  const marker = "setTimeout(() => void cleanupAbandoned().catch((e) => console.error('cleanup:', e.message)), 20_000).unref?.();";
  if (!source.includes(marker)) throw new Error('Trakt cleanup patch failed: timer marker');

  const runner = `
if (process.env.CLEAN_PUBLIC_TRAKT === '1') {
  setTimeout(async () => {
    const id = String(process.env.CLEAN_PROFILE_ID || '').trim();
    const result = { profileId: id ? \`\${id.slice(0,4)}…\${id.slice(-4)}\` : '', cleaned: false, remainingPersonalTraktKeys: [] };
    try {
      if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('invalid profile id');

      const fixedKeys = [
        SHARED_TRAKT_KEY,
        tokenKey(id),
        deviceKey(id),
        pullKey(id),
        watchedKey(id),
        resumeKey(id),
        statusKey(id),
        lockKey(id),
        droppedKey(id),
      ];
      await redis.del(fixedKeys);

      for (const pattern of [\`jc:recent:\${id}:*\`, \`jc:event:\${id}:*\`]) {
        let cursor = '0';
        do {
          const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
          cursor = String(reply.cursor);
          if (reply.keys?.length) await redis.del(reply.keys);
        } while (cursor !== '0');
      }

      const checks = [];
      for (const pattern of ['jc:trakt:*', \`jc:recent:\${id}:*\`, \`jc:event:\${id}:*\`, \`jc:watched:\${id}\`, \`jc:resume:\${id}\`, \`jc:pull:\${id}\`]) {
        let cursor = '0';
        do {
          const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
          cursor = String(reply.cursor);
          for (const key of reply.keys || []) {
            if (key === SHARED_TRAKT_KEY || key === tokenKey(id) || key === deviceKey(id) || key.startsWith(\`jc:recent:\${id}:\`) || key.startsWith(\`jc:event:\${id}:\`) || key === watchedKey(id) || key === resumeKey(id) || key === pullKey(id)) checks.push(key);
          }
        } while (cursor !== '0');
      }
      result.remainingPersonalTraktKeys = checks;
      result.cleaned = checks.length === 0;
    } catch (e) {
      result.error = String(e?.message || e).slice(0, 300);
    }
    console.log('PUBLIC_TRAKT_CLEANUP_RESULT', JSON.stringify(result));
  }, 5000).unref?.();
}
`;
  source = source.replace(marker, `${runner}\n${marker}`);
}

await writeFile(file, source, 'utf8');
console.log('Applied one-time public Trakt cleanup');
