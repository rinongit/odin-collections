import { spawn } from 'node:child_process';

const PORT = 17891;
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['bootstrap.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Server did not start. ${stderr}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await waitForServer();

  const health = await fetch(`${base}/health`).then((r) => r.json());
  assert(health.ok === true, 'health endpoint failed');

  const status = await fetch(`${base}/api/source-status`).then((r) => r.json());
  assert(typeof status.tmdb === 'boolean', 'source-status missing tmdb');
  assert(typeof status.trakt === 'boolean', 'source-status missing trakt');
  assert(typeof status.mdblist === 'boolean', 'source-status missing mdblist');

  const config = {
    name: 'Odin Smoke Test',
    description: 'Automated deployment test',
    folders: [
      {
        id: 'netflix',
        name: 'Netflix',
        image: 'https://example.com/netflix-landscape.jpg',
        background: 'https://example.com/netflix-bg.jpg',
        posterShape: 'landscape',
        catalogs: [
          {
            sourceKind: 'tmdb',
            sourceUrl: 'https://www.themoviedb.org/list/123',
            type: 'movie',
            id: 'sample-list',
            catalogId: 'sample-list',
            name: 'Sample List',
            posterShape: 'poster'
          }
        ]
      }
    ]
  };

  const encodedResponse = await fetch(`${base}/api/encode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  assert(encodedResponse.ok, `encode failed: ${encodedResponse.status}`);
  const encoded = await encodedResponse.json();
  assert(encoded.token, 'encode did not return a token');

  const manifestResponse = await fetch(`${base}/c/${encoded.token}/manifest.json`);
  assert(manifestResponse.ok, `manifest failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  assert(manifest.name === 'Odin Smoke Test', 'manifest name mismatch');
  assert(manifest.catalogs.some((c) => c.id === 'odin-folders'), 'folders catalog missing');
  assert(manifest.catalogs.some((c) => c.name === 'Netflix • Sample List'), 'child catalog missing');

  const foldersResponse = await fetch(`${base}/c/${encoded.token}/catalog/movie/odin-folders.json`);
  assert(foldersResponse.ok, `folder catalog failed: ${foldersResponse.status}`);
  const folders = await foldersResponse.json();
  assert(Array.isArray(folders.metas) && folders.metas.length === 1, 'folder card missing');
  assert(folders.metas[0].poster === 'https://example.com/netflix-landscape.jpg', 'custom folder image lost');
  assert(folders.metas[0].posterShape === 'landscape', 'landscape poster shape lost');

  const configResponse = await fetch(`${base}/c/${encoded.token}/config.json`);
  assert(configResponse.ok, `config endpoint failed: ${configResponse.status}`);
  const roundTrip = await configResponse.json();
  assert(roundTrip.folders[0].catalogs[0].sourceKind === 'tmdb', 'TMDB list source was not preserved');
  assert(roundTrip.folders[0].catalogs[0].posterShape === 'poster', 'catalog poster shape was not preserved');

  console.log('Odin Catalog Builder smoke test passed');
} finally {
  child.kill('SIGTERM');
}
