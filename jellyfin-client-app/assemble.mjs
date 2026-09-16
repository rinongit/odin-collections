import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const packed = (await readFile(new URL('./server.mjs.gz.b64', import.meta.url), 'utf8')).trim();
const source = gunzipSync(Buffer.from(packed, 'base64'));
await writeFile(new URL('./server.mjs', import.meta.url), source);
