// Downloads the pure-Python wheels pytest needs (pinned in wheels.json, sha256-checked) into
// public/vendor/pyodide/wheels so they are SELF-HOSTED next to Pyodide. This runs at BUILD time only.
// At runtime Lynceus never contacts PyPI (package downloads are off in v1).
// Offline build: pass --from <dir> holding the same .whl files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WHEELS = JSON.parse(fs.readFileSync(new URL('./wheels.json', import.meta.url), 'utf8'));
const dst = path.resolve('public/vendor/pyodide/wheels');
const fromIdx = process.argv.indexOf('--from');
const fromDir = fromIdx > 0 ? path.resolve(process.argv[fromIdx + 1]) : null;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

fs.mkdirSync(dst, { recursive: true });
let fetched = 0;
for (const w of WHEELS) {
  const out = path.join(dst, w.file);
  if (fs.existsSync(out) && sha(fs.readFileSync(out)) === w.sha256) continue;
  let buf;
  if (fromDir && fs.existsSync(path.join(fromDir, w.file))) buf = fs.readFileSync(path.join(fromDir, w.file));
  else {
    const res = await fetch(w.url).catch((e) => { throw new Error(`could not download ${w.file}: ${e.message}. ` +
      'Check the internet connection (behind a proxy, run with NODE_USE_ENV_PROXY=1) or pass --from <dir>.'); });
    if (!res.ok) throw new Error(`could not download ${w.file}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (sha(buf) !== w.sha256) throw new Error(`sha256 mismatch for ${w.file}: refusing to use it`);
  fs.writeFileSync(out, buf);
  fetched++;
}
fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(WHEELS.map((w) => w.file)));
console.log(`wheels: ${WHEELS.length} checked, ${fetched} fetched -> public/vendor/pyodide/wheels`);
