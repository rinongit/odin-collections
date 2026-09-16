import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./server.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('function isDroppedTraktShow(show, dropped)')) {
  const anchor = 'async function fetchTraktState(id) {';
  if (!source.includes(anchor)) throw new Error('Dropped-pull patch failed: fetchTraktState anchor');
  const helper = `function isDroppedTraktShow(show, dropped) {
  if (!show || !dropped?.size) return false;
  const ids = show.ids || {};
  const tokens = [];
  if (typeof ids.imdb === 'string' && /^tt\\d+$/i.test(ids.imdb)) tokens.push(\`imdb:\${ids.imdb.toLowerCase()}\`);
  if (Number.isInteger(Number(ids.tmdb)) && Number(ids.tmdb) > 0) tokens.push(\`tmdb:\${Number(ids.tmdb)}\`);
  if (Number.isInteger(Number(ids.tvdb)) && Number(ids.tvdb) > 0) tokens.push(\`tvdb:\${Number(ids.tvdb)}\`);
  if (Number.isInteger(Number(ids.trakt)) && Number(ids.trakt) > 0) tokens.push(\`trakt:\${Number(ids.trakt)}\`);
  const title = normalizeDroppedTitle(show.title);
  if (title) tokens.push(\`name:\${title}\`);
  return tokens.some((token) => dropped.has(token));
}
`;
  source = source.replace(anchor, `${helper}\n${anchor}`);
}

const oldFetch = `async function fetchTraktState(id) {
  const [pm, pe, wm, ws] = await Promise.all([
    traktPages(id, '/sync/playback/movies?extended=full'),
    traktPages(id, '/sync/playback/episodes?extended=full'),
    traktPages(id, '/sync/watched/movies'),
    traktPages(id, '/sync/watched/shows?extended=progress'),
  ]);
  const resumes = [...pm.map(resumeMovie), ...pe.map(resumeEpisode)].filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  return { resumes, watched: watchedEntries(wm, ws) };
}`;

const newFetch = `async function fetchTraktState(id) {
  const [pm, pe, wm, ws, dropped] = await Promise.all([
    traktPages(id, '/sync/playback/movies?extended=full'),
    traktPages(id, '/sync/playback/episodes?extended=full'),
    traktPages(id, '/sync/watched/movies'),
    traktPages(id, '/sync/watched/shows?extended=progress'),
    getDroppedSet(id),
  ]);
  const visibleEpisodes = pe.filter((row) => !isDroppedTraktShow(row?.show, dropped));
  const resumes = [...pm.map(resumeMovie), ...visibleEpisodes.map(resumeEpisode)].filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  return { resumes, watched: watchedEntries(wm, ws) };
}`;

if (source.includes(oldFetch)) source = source.replace(oldFetch, newFetch);
else if (!source.includes('const visibleEpisodes = pe.filter')) throw new Error('Dropped-pull patch failed: fetchTraktState body');

const oldSyncOrder = `    const state = await fetchTraktState(id);
    await getDroppedSet(id, true);`;
const newSyncOrder = `    await getDroppedSet(id, true);
    const state = await fetchTraktState(id);`;
if (source.includes(oldSyncOrder)) source = source.replace(oldSyncOrder, newSyncOrder);
else if (!source.includes(newSyncOrder)) throw new Error('Dropped-pull patch failed: sync refresh order');

await writeFile(file, source, 'utf8');
console.log('Applied dropped-show filtering to Trakt resume pull');
