import { readFile, writeFile } from 'node:fs/promises';

const serverFile = new URL('./server.mjs', import.meta.url);
const proxyFile = new URL('./jellyfin-proxy.mjs', import.meta.url);

let server = await readFile(serverFile, 'utf8');

const replacements = [
  [
    '<div class="box"><h3>1. Trakt</h3>',
    '<div class="box"><h3>1. Connect Trakt</h3><p class="muted">Click <strong>Connect Trakt</strong>. A Trakt page will open. Sign in, enter the code shown if asked, and approve the connection. Then return here. You do not need your own API key.</p>'
  ],
  [
    '<div class="box"><h3>2. Jellyfin Client server</h3>',
    '<div class="box"><h3>2. Connect your Jellyfin server</h3><p class="muted">Paste the <strong>same server address you normally use to see your movies and shows</strong>. Then enter the same username/configuration ID and password you normally use and press <strong>Connect Jellyfin Client</strong>.</p>'
  ],
  [
    '<label>Jellyfin Client server URL</label>',
    '<label>Your current Jellyfin server address</label>'
  ],
  [
    '<label>Username / configuration ID or alias</label>',
    '<label>Username / configuration ID or alias — use the same one you normally use</label>'
  ],
  [
    '<div class="box"><h3>3. Watch-state manifest</h3>\n      <p>Use this private manifest for watch-state synchronization:</p>',
    '<div class="box"><h3>3. Add the watch-state manifest</h3>\n      <p>Copy the private URL below. In your Jellyfin server configuration, add it as the <strong>Custom Addon / watch-state manifest</strong>. This is what lets your playback activity be sent to Trakt.</p>'
  ],
  [
    '<div class="box"><h3>4. Filtered Jellyfin Client URL</h3>\n      <p>Use this as your Jellyfin server URL to hide unaired episodes from Continue Watching and keep Next Up / Upcoming to one episode per show:</p>',
    '<div class="box"><h3>4. Copy your final Jellyfin Client server address</h3>\n      <p><strong>Copy the URL below and add it to your Jellyfin client as the server address.</strong> Use this new address instead of your original server address in the client. Your normal libraries and catalogs still come from your original server automatically.</p>'
  ],
  [
    '<p>Open Trakt activation and enter this code:</p>',
    '<p><strong>1.</strong> Tap <strong>Open Trakt activation</strong> below.<br><strong>2.</strong> Sign in to Trakt if needed.<br><strong>3.</strong> Enter this code:</p>'
  ],
  [
    '<p id="status" class="muted">Waiting for authorization…</p>',
    '<p id="status" class="muted">After you approve the code on Trakt, keep this page open. It will finish automatically.</p>'
  ],
];

for (const [from, to] of replacements) {
  if (server.includes(from)) server = server.replace(from, to);
  else console.log(`UI patch note: text not found: ${from.slice(0, 70)}`);
}
await writeFile(serverFile, server, 'utf8');

let proxy = await readFile(proxyFile, 'utf8');
const setupDetection = "const setupPage = req.method === 'GET' && /^\\/u\\/[a-f0-9]{12}\\/setup$/.test(u.pathname);";
if (proxy.includes(setupDetection)) {
  proxy = proxy.replace(setupDetection, 'const setupPage = false; // setup page is rendered once by server.mjs');
  await writeFile(proxyFile, proxy, 'utf8');
} else {
  console.log('UI patch note: proxy setup injection toggle was not found');
}

console.log('Applied clean single-page Jellyfin Client UI');
