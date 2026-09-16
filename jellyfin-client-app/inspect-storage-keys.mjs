import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const lines = source.split('\n');
const matches = [];
for (const line of lines) {
  if (!/\b(?:const|function)\s+\w*Key\b/.test(line) && !line.includes('jc:')) continue;
  const cleaned = line.trim();
  if (cleaned.length > 240) continue;
  matches.push(cleaned);
}
console.log('JC_STORAGE_KEY_DEFS', JSON.stringify(matches));
