const nativeFetch = globalThis.fetch;

function normalizeTraktImages(value) {
  if (typeof value === 'string') {
    if (/^[a-z0-9.-]+\.trakt\.tv\/images\//i.test(value)) return `https://${value}`;
    if (/^\/\/[a-z0-9.-]+\.trakt\.tv\/images\//i.test(value)) return `https:${value}`;
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeTraktImages);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = normalizeTraktImages(value[key]);
  }
  return value;
}

globalThis.fetch = async function odinFetch(input, init) {
  const response = await nativeFetch(input, init);
  let url;
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  } catch {
    return response;
  }

  if (url.hostname !== 'api.trakt.tv') return response;
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.includes('json')) return response;

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  normalizeTraktImages(parsed);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(parsed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

await import('./server.mjs');
