import { readFile, writeFile } from 'node:fs/promises';

const serverFile = new URL('./server.mjs', import.meta.url);
const proxyFile = new URL('./jellyfin-proxy.mjs', import.meta.url);
let server = await readFile(serverFile, 'utf8');

function replaceOnce(from, to, label) {
  if (!server.includes(from)) throw new Error(`Behavior patch failed: ${label}`);
  server = server.replace(from, to);
}

if (!server.includes('const droppedKey = (id)')) {
  replaceOnce(
    "const recentKey = (id, item) => `jc:recent:${id}:${item}`;",
    "const recentKey = (id, item) => `jc:recent:${id}:${item}`;\nconst droppedKey = (id) => `jc:dropped:${id}`;",
    'dropped key anchor'
  );
}

if (!server.includes('function droppedTokenSet(rows)')) {
  const helper = `
function normalizeDroppedTitle(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\\p{M}+/gu, '')
    .replace(/\\s+/g, ' ');
}
function droppedTokenSet(rows) {
  const out = new Set();
  for (const row of rows || []) {
    const show = row?.show;
    if (!show) continue;
    const ids = show.ids || {};
    if (typeof ids.imdb === 'string' && /^tt\\d+$/i.test(ids.imdb)) out.add(\`imdb:\${ids.imdb.toLowerCase()}\`);
    if (Number.isInteger(Number(ids.tmdb)) && Number(ids.tmdb) > 0) out.add(\`tmdb:\${Number(ids.tmdb)}\`);
    if (Number.isInteger(Number(ids.tvdb)) && Number(ids.tvdb) > 0) out.add(\`tvdb:\${Number(ids.tvdb)}\`);
    if (Number.isInteger(Number(ids.trakt)) && Number(ids.trakt) > 0) out.add(\`trakt:\${Number(ids.trakt)}\`);
    const title = normalizeDroppedTitle(show.title);
    if (title) out.add(\`name:\${title}\`);
  }
  return out;
}
async function getDroppedSet(id, force = false) {
  const cached = await loadJson(droppedKey(id));
  if (!force && Array.isArray(cached)) return new Set(cached);
  try {
    const rows = await traktPages(id, '/users/hidden/dropped');
    const set = droppedTokenSet(rows);
    await redis.set(droppedKey(id), JSON.stringify([...set]), { EX: 24 * 60 * 60 });
    return set;
  } catch (error) {
    if (Array.isArray(cached)) return new Set(cached);
    console.error(\`Dropped-state \${id}:\`, error?.message || error);
    return new Set();
  }
}
`;
  replaceOnce('function resumeMovie(row) {', `${helper}\nfunction resumeMovie(row) {`, 'dropped helpers anchor');
}

if (!server.includes('function packedShowToken(raw)')) {
  const filterHelpers = `
function packedShowToken(raw) {
  const hex = String(raw || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return '';
  const buf = Buffer.from(hex, 'hex');
  if (buf[0] !== 0xa1) return '';
  const kind = buf[1] >> 4;
  if (![2, 3, 4].includes(kind)) return '';
  const idType = buf[1] & 0x0f;
  const numeric = buf.readUIntBE(3, 6);
  if (idType === 1) return \`imdb:tt\${String(numeric).padStart(7, '0')}\`;
  if (idType === 2) return \`tmdb:\${numeric}\`;
  if (idType === 3) return \`tvdb:\${numeric}\`;
  return '';
}
function droppedShowTokensForItem(item) {
  const out = new Set();
  const type = String(item?.Type || '').toLowerCase();
  if (type !== 'series' && type !== 'episode' && type !== 'season') return out;
  if (type === 'series') {
    const ids = item?.ProviderIds || {};
    const imdb = ids.Imdb ?? ids.IMDb ?? ids.IMDB;
    const tmdb = ids.Tmdb ?? ids.TMDB;
    const tvdb = ids.Tvdb ?? ids.TVDB;
    const trakt = ids.Trakt ?? ids.TRAKT;
    if (typeof imdb === 'string' && /^tt\\d+$/i.test(imdb)) out.add(\`imdb:\${imdb.toLowerCase()}\`);
    if (Number.isInteger(Number(tmdb)) && Number(tmdb) > 0) out.add(\`tmdb:\${Number(tmdb)}\`);
    if (Number.isInteger(Number(tvdb)) && Number(tvdb) > 0) out.add(\`tvdb:\${Number(tvdb)}\`);
    if (Number.isInteger(Number(trakt)) && Number(trakt) > 0) out.add(\`trakt:\${Number(trakt)}\`);
  }
  const packed = packedShowToken(item?.SeriesId || item?.Id || item?.ParentId);
  if (packed) out.add(packed);
  const name = normalizeDroppedTitle(type === 'series' ? item?.Name : item?.SeriesName);
  if (name) out.add(\`name:\${name}\`);
  return out;
}
function isDroppedShowItem(item, dropped) {
  if (!dropped?.size) return false;
  for (const token of droppedShowTokensForItem(item)) if (dropped.has(token)) return true;
  return false;
}
`;
  replaceOnce('function transformShelf(path, json) {', `${filterHelpers}\nfunction transformShelf(path, json, dropped = new Set()) {`, 'shelf filter anchor');
  replaceOnce(
    '  let items = json.Items;\n  const now = Date.now();',
    '  let items = json.Items.filter((item) => !isDroppedShowItem(item, dropped));\n  const now = Date.now();',
    'shelf items anchor'
  );
  replaceOnce(
    '        else value = transformShelf(rest, value);',
    '        else value = transformShelf(rest, value, dropped);',
    'transform call anchor'
  );
}

if (!server.includes('const dropped = shelfPath ? await getDroppedSet(id) : new Set();')) {
  replaceOnce(
    "  const basePath = upstreamBase.pathname.replace(/\\/+$/, '');",
    "  const shelfPath = isResumePath(rest) || isNextUpPath(rest) || isUpcomingPath(rest);\n  const dropped = shelfPath ? await getDroppedSet(id) : new Set();\n\n  const basePath = upstreamBase.pathname.replace(/\\/+$/, '');",
    'proxy dropped cache anchor'
  );
}

if (!server.includes("await getDroppedSet(id, true);")) {
  replaceOnce(
    '    const state = await fetchTraktState(id);',
    '    const state = await fetchTraktState(id);\n    await getDroppedSet(id, true);',
    'scheduled dropped refresh anchor'
  );
}

// Scrobble dedupe must only be set after Trakt confirms a successful stop.
const oldStopDedupe = `    if (ev === 'stop' && progress >= 80) {
      await redis.set(recentKey(id, dedupeKey(target)), '1', { EX: 180 });
    }`;
if (server.includes(oldStopDedupe)) {
  server = server.replace(
    oldStopDedupe,
    `    if (ev === 'start') {
      await redis.del(recentKey(id, dedupeKey(target)));
    }`
  );
}
if (!server.includes("EX: 6 * 60 * 60")) {
  replaceOnce(
    '    await redis.del(pullKey(id));\n    return sendJson(res, 200, { ok: true, event: ev, type, traktStatus: r.status });',
    `    if (ev === 'stop' && progressFor(body) >= 80) {
      await redis.set(recentKey(id, dedupeKey(target)), '1', { EX: 6 * 60 * 60 });
    }
    await redis.del(pullKey(id));
    return sendJson(res, 200, { ok: true, event: ev, type, traktStatus: r.status });`,
    'successful scrobble dedupe anchor'
  );
}

// Remove dropped cache with sync state/profile cleanup.
server = server.replace(
  'pullKey(id), watchedKey(id), resumeKey(id), statusKey(id), lockKey(id)]',
  'pullKey(id), watchedKey(id), resumeKey(id), statusKey(id), lockKey(id), droppedKey(id)]'
);
server = server.replace(
  'watchedKey(id), resumeKey(id), statusKey(id), lockKey(id),\n  ]);',
  'watchedKey(id), resumeKey(id), statusKey(id), lockKey(id), droppedKey(id),\n  ]);'
);

await writeFile(serverFile, server, 'utf8');

// Old filtered URL aliases now route through the canonical /j/ handler so every
// client gets exactly the same dropped-show and shelf filtering behavior.
let proxy = await readFile(proxyFile, 'utf8');
const oldAliasRoute = `      if (parsed) {
        await proxyToConnectedServer(req, res, parsed);
        return;
      }`;
const newAliasRoute = `      if (parsed) {
        req.url = \`/j/\${parsed.id}/\${encodeURIComponent(parsed.key)}\${parsed.rest}\${incoming.search}\`;
        proxyToChild(req, res, childPort);
        return;
      }`;
if (proxy.includes(oldAliasRoute)) proxy = proxy.replace(oldAliasRoute, newAliasRoute);
else if (!proxy.includes("req.url = `/j/${parsed.id}")) throw new Error('Behavior patch failed: alias route anchor');
await writeFile(proxyFile, proxy, 'utf8');

console.log('Applied dropped-show filtering and scrobble hardening');
