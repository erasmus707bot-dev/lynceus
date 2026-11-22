# Lynceus Phase 0 spike (throwaway)

This folder is report-only proof code, not the app. Phase 1 starts fresh.

## Run it on gandalf

```bash
cd ~/Lynceus/spike
python3 serve.py          # app on http://127.0.0.1:8000/  sink on :8001
# open http://127.0.0.1:8000/index.html, then each spike page, tap Run
```

Automated check (needs Node + Playwright with Chromium):

```bash
cd ~/Lynceus/spike
node check.mjs            # starts/stops serve.py itself; log -> ../docs/logs/phase0-check.json
```

## What's here

- `py.html` + `py-worker.js`: (a) pytest + coverage.py per-test contexts in self-hosted Pyodide
- `js.html` + `js-worker.js`: (b) istanbul instrumentation + Jest-style shim in a Worker
- `exfil.html` + `samples/exfil/`: (c) planted exfiltration tests (Python + JS)
- `guard.js`: worker network stubs; `boot.js`: blob: worker bootstrap (inherits the page CSP)
- `sw.js`: service worker, caches app files only
- `serve.py`: static server + a "sink" server that logs any leaked request to `sink-hits.jsonl`
- `vendor/`: pinned Pyodide 314.0.7 core (from npm), pure-Python wheels, bundled istanbul

## Rebuild vendor files (only if needed)

```bash
npm ci
npx esbuild istanbul-entry.js --bundle --format=esm --platform=browser --minify \
  --outfile=vendor/istanbul.mjs --alias:path=path-browserify --alias:crypto=./shims/crypto.js \
  --inject:./shims/process.js --define:process.env.NODE_ENV='"production"'
cp node_modules/pyodide/{pyodide.mjs,pyodide.asm.mjs,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json,package.json} vendor/pyodide/
```
