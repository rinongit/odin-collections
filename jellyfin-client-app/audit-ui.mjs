import { readFile } from 'node:fs/promises';

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

function summarize(name, source) {
  const tags = {
    divOpen: count(source, /<div\b/gi), divClose: count(source, /<\/div>/gi),
    formOpen: count(source, /<form\b/gi), formClose: count(source, /<\/form>/gi),
    htmlOpen: count(source, /<html\b/gi), htmlClose: count(source, /<\/html>/gi),
    bodyOpen: count(source, /<body\b/gi), bodyClose: count(source, /<\/body>/gi),
  };
  const headings = [...source.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis)]
    .map((m) => m[2].replace(/<[^>]+>/g, '').replace(/\$\{[^}]*\}/g, '{dynamic}').replace(/\s+/g, ' ').trim())
    .filter(Boolean).slice(0, 50);
  const ids = [...source.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
  const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  console.log(`[UI-AUDIT] ${name} tags=${JSON.stringify(tags)} dupIds=${JSON.stringify(dupIds)}`);
  console.log(`[UI-AUDIT] ${name} headings=${JSON.stringify(headings)}`);
}

function safeSnippet(source, needle) {
  const i = source.indexOf(needle);
  if (i < 0) return '';
  let s = source.slice(Math.max(0, i - 120), Math.min(source.length, i + 1100));
  s = s.replace(/\$\{[^}]{0,800}\}/gs, '{dynamic}');
  s = s.replace(/https?:\/\/[^\s"'<>`]+/g, '{url}');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 1000);
}

const server = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const proxy = await readFile(new URL('./jellyfin-proxy.mjs', import.meta.url), 'utf8');

summarize('server', server);
summarize('proxy', proxy);
for (const heading of ['1. Trakt', '2. Jellyfin Client server', '3. Watch-state manifest', '4. Filtered Jellyfin Client URL']) {
  console.log(`[UI-AUDIT] section ${heading}: ${safeSnippet(server, heading)}`);
}
