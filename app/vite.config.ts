import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PYODIDE_DIR = path.dirname(require.resolve('pyodide/package.json'));
const PYODIDE_VERSION: string = require('pyodide/package.json').version;
const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const PYODIDE_BYTES = PYODIDE_FILES.reduce((n, f) => n + fs.statSync(path.join(PYODIDE_DIR, f)).size, 0);

// Content-Security-Policy, delivered by <meta> because GitHub Pages can't set headers.
// Verified in Phase 0 (docs/PHASE0_REPORT.md). Added to the BUILD only: Vite's dev server
// needs inline scripts and a websocket that this policy correctly forbids.
// 'unsafe-eval' is kept for the Phase 3 JS test runner (blob: workers inherit this policy).
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'lynceus-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`),
  };
}

// Writes the list of built app files into dist/sw.js so the service worker caches
// exactly the app (never user code), and gives the cache a content-based version.
function swManifest(): Plugin {
  return {
    name: 'lynceus-sw-manifest',
    apply: 'build',
    closeBundle() {
      const dist = path.resolve('dist');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (f !== 'sw.js' && !path.relative(dist, p).startsWith('vendor')) files.push(path.relative(dist, p).split(path.sep).join('/'));
        }
      };
      walk(dist);
      files.sort();
      const swPath = path.join(dist, 'sw.js');
      const h = crypto.createHash('sha256');
      for (const f of files) h.update(f).update(fs.readFileSync(path.join(dist, f)));
      const version = h.digest('hex').slice(0, 16);
      const sw = fs.readFileSync(swPath, 'utf8')
        .replace('self.__LYNCEUS_FILES__', JSON.stringify(['./', ...files]))
        .replace('__LYNCEUS_VERSION__', version)
        .replace('__PYODIDE_CACHE__', 'lynceus-pyodide-' + PYODIDE_VERSION);
      fs.writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  base: '/', // lynceus.scottchristensen.dev (decided 2026-11-22); relative asset URLs still work on localhost
  plugins: [svelte(), cspMeta(), swManifest()],
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  define: { __PYODIDE_VERSION__: JSON.stringify(PYODIDE_VERSION), __PYODIDE_BYTES__: String(PYODIDE_BYTES) },
  test: { environment: 'jsdom', include: ['tests/unit/**/*.test.ts'] },
});
