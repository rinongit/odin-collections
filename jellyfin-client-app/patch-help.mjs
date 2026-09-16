import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./jellyfin-proxy.mjs', import.meta.url);
let source = await readFile(file, 'utf8');

if (!source.includes('jc-easy-steps')) {
  const old = `  const card = \`<div class="box"><h3>Jellyfin Client Server URL</h3><p>Use this URL in your Jellyfin client. It keeps all libraries and catalogs from the server you connected above, while filtering Continue Watching, Next Up and Upcoming.</p><code style="word-break:break-all">\${url}</code></div>\`;`;

  const replacement = `  const card = \`<!-- jc-easy-steps -->
  <div class="box" style="border:2px solid #2563eb;background:#f8fbff">
    <h3>Easy version — Steps 3, 4 and 5</h3>
    <p><strong>Step 3 — Connect Trakt</strong><br>Press <strong>Connect Trakt</strong>. Trakt will open. Sign in to your Trakt account, approve the connection, then come back to this page. If Trakt shows a code, enter that code on the Trakt page. You do not need a Trakt API key.</p>
    <p><strong>Step 4 — Connect your Jellyfin server</strong><br>In the Jellyfin section, paste the <strong>same server URL you already use now to see your catalogs</strong>. Enter the same username/configuration name and password you normally use, then press <strong>Connect Jellyfin</strong>. When the page says <strong>Connected</strong>, this step is finished.</p>
    <p><strong>Step 5 — Put the new URL in your Jellyfin client</strong><br>Copy the <strong>Jellyfin Client Server URL</strong> shown just below this box. In your Jellyfin client, add that copied URL as the server address and sign in with the same account. Your normal catalogs still come from your original server automatically; this new URL only sits in front of it to add Trakt sync and the shelf fixes.</p>
  </div>
  <div class="box"><h3>Jellyfin Client Server URL</h3><p><strong>Copy this URL and use it as the server address in your Jellyfin client:</strong></p><code style="word-break:break-all">\${url}</code></div>\`;`;

  if (!source.includes(old)) {
    throw new Error('Could not find Jellyfin Client setup card to add easy instructions');
  }
  source = source.replace(old, replacement);
  await writeFile(file, source, 'utf8');
  console.log('Added easy Jellyfin Client setup instructions');
}
