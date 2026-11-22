// Copies the pinned Pyodide core (from node_modules, version locked in package-lock.json)
// into public/vendor/pyodide so it is SELF-HOSTED: no CDN is ever contacted at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const src = path.dirname(require.resolve('pyodide/package.json'));
const dst = path.resolve('public/vendor/pyodide');
const FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'package.json'];
fs.mkdirSync(dst, { recursive: true });
for (const f of FILES) {
  const a = path.join(src, f), b = path.join(dst, f);
  if (!fs.existsSync(b) || fs.statSync(a).size !== fs.statSync(b).size) fs.copyFileSync(a, b);
}
console.log(`pyodide ${require('pyodide/package.json').version} -> public/vendor/pyodide`);
