import { readFile } from 'node:fs/promises';

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

function summarize(name, source) {
  const tags = {
    divOpen: count(source, /<div\b/gi),
    divClose: count(source, /<\/div>/gi),
    formOpen: count(source, /<form\b/gi),
    formClose: count(source, /<\/form>/gi),
    htmlOpen: count(source, /<html\b/gi),
    htmlClose: count(source, /<\/html>/gi),
    bodyOpen: count(source, /<body\b/gi),
    bodyClose: count(source, /<\/body>/gi),
  };
  const headings = [...source.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis)]
    .map((m) => m[2].replace(/<[^>]+>/g, '').replace(/\$\{[^}]*\}/g, '{dynamic}').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 50);
  const ids = [...source.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
  const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const nestedFormHints = count(source, /<form\b[\s\S]{0,2500}<form\b/gi);
  console.log(`[UI-AUDIT] ${name} tags=${JSON.stringify(tags)} dupIds=${JSON.stringify(dupIds)} nestedFormHints=${nestedFormHints}`);
  console.log(`[UI-AUDIT] ${name} headings=${JSON.stringify(headings)}`);
}

const server = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const proxy = await readFile(new URL('./jellyfin-proxy.mjs', import.meta.url), 'utf8');

summarize('server', server);
summarize('proxy', proxy);

for (const [name, source] of [['server', server], ['proxy', proxy]]) {
  const suspicious = [];
  if (source.includes('</form></form>')) suspicious.push('double-form-close');
  if (source.includes('<form><form')) suspicious.push('direct-nested-form');
  if (source.includes('</body></div>')) suspicious.push('content-after-body');
  if (source.includes('jc-easy-steps') && name === 'proxy') suspicious.push('runtime-help-patch-active');
  console.log(`[UI-AUDIT] ${name} suspicious=${JSON.stringify(suspicious)}`);
}
