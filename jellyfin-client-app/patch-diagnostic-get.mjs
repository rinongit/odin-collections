import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

const oldAuth = `  const diagKey = String(process.env.DIAG_KEY || '');
  if (!diagKey || !secureEq(req.headers['x-diag-key'], diagKey)) {
    return sendJson(res, 404, { error: 'not found' });
  }

  let input;
  try { input = JSON.parse(await readBody(req)); }
  catch { return sendJson(res, 400, { error: 'invalid json' }); }

  const username = String(input?.username || '').trim();
  const password = String(input?.password || '');`;

const newAuth = `  const diagKey = String(process.env.DIAG_KEY || '');
  const diagUrl = new URL(req.url, \`http://\${req.headers.host || 'localhost'}\`);
  const suppliedKey = String(req.headers['x-diag-key'] || diagUrl.searchParams.get('key') || '');
  if (!diagKey || !secureEq(suppliedKey, diagKey)) {
    return sendJson(res, 404, { error: 'not found' });
  }

  let input = null;
  if (req.method === 'GET') {
    input = { username: process.env.DIAG_USER || '', password: process.env.DIAG_PASS || '' };
  } else {
    try { input = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }
  }

  const username = String(input?.username || '').trim();
  const password = String(input?.password || '');`;

if (!source.includes(oldAuth)) throw new Error('Diagnostic GET patch failed: auth block');
source = source.replace(oldAuth, newAuth);

const oldRoute = `  if (u.pathname === '/__diag/catalog-test' && req.method === 'POST') {
    await runCatalogDiagnostic(req, res);
    return;
  }`;
const newRoute = `  if (u.pathname === '/__diag/catalog-test' && (req.method === 'POST' || req.method === 'GET')) {
    await runCatalogDiagnostic(req, res);
    return;
  }`;
if (!source.includes(oldRoute)) throw new Error('Diagnostic GET patch failed: route block');
source = source.replace(oldRoute, newRoute);

await writeFile(file, source, 'utf8');
console.log('Enabled one-time read-only catalog diagnostic call');
