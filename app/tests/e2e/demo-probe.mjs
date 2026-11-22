// Prints the Queue for each bundled demo after running its tests (used for the Phase 6 hand check).
import { createRequire } from 'module';
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.zip': 'application/zip', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const s = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x/').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => s.listen(4175, '127.0.0.1', r));
const browser = await chromium.launch();
for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['javascript', 'python']) {
  const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await p.goto('http://127.0.0.1:4175/');
  await p.getByTestId(`demo-${id}`).click();
  const nav = p.locator('nav.inline');
  if (id === 'python') {
    await nav.getByRole('button', { name: 'Code' }).click();
    const c = p.getByRole('button', { name: 'Download Python support' });
    await c.waitFor({ timeout: 30000 }); await c.click();
    await p.locator('[data-line="2"]').waitFor({ timeout: 120000 });
  }
  await nav.getByRole('button', { name: 'Tests' }).click();
  await p.getByRole('button', { name: /^Run tests/ }).click();
  await p.getByTestId('test-summary').waitFor({ timeout: 180000 });
  console.log(`== ${id}: ${await p.getByTestId('test-summary').innerText()}`);
  for (const li of await p.getByTestId('result').all()) console.log('  ', await li.getAttribute('data-outcome'), (await li.locator('.name').innerText()).trim());
  await nav.getByRole('button', { name: 'Queue' }).click();
  await p.getByTestId('queue-item').first().waitFor();
  for (const li of await p.getByTestId('queue-item').all()) {
    await li.getByTestId('score').click();
    console.log('--', await li.getAttribute('data-fn'), (await li.getByTestId('score').innerText()).trim());
    console.log((await li.getByTestId('breakdown').innerText()).replace(/\n+/g, ' | '));
    await li.getByTestId('score').click();
  }
  await p.close();
}
await browser.close(); s.close();
