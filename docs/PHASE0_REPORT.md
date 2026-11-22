# Lynceus Phase 0 report (feasibility spike)

*Run 2026-11-22 in a cloud container with headless Chromium (Playwright). Not yet re-run on gandalf.*
*Full log: `docs/logs/phase0-check.json`. Re-run: `cd spike && node check.mjs`.*

## Verdict

- **(a) pytest + coverage.py per-test contexts in self-hosted Pyodide, offline: PASS**
- **(b) istanbul + test shim in a Worker: PASS**
- **(c) CSP + worker stubs block every exfiltration path: PASS** (0 hits at the sink)
- **(d) scottchristensen.dev on GitHub Pages: FAIL as written.** It's on Porkbun hosting. Scott chose the subdomain `lynceus.scottchristensen.dev` on GitHub Pages instead. Not yet set up or verified.

## (a) Python

- Pinned **Pyodide 314.0.7** (Python 3.14), core files taken from the npm package. GitHub releases and jsdelivr were blocked from the build box, so I didn't use them.
- Wheels installed by unzipping into site-packages. **No micropip, no PyPI** at runtime: pytest 9.2.0, coverage 7.17.2, pluggy 1.7.0, iniconfig 2.3.1, packaging 26.3, pygments 2.21.0.
- coverage runs on its **pure-Python tracer** (`COVERAGE_CORE=pytrace`, because the C tracer isn't available). `dynamic_context = test_function` works. Each line maps to the exact tests that ran it.
- Sample result: 3 passed and 1 failed, as planted. The uncovered lines came out exactly as hand-computed (5, 20, 21).
- **Offline:** the server was killed and the browser set offline, then the run was repeated. It passed, with every file served by the service worker. Service-worker control does reach blob: workers in Chromium.
- **Size:** about **15.6 MB** of Python assets (13.5 MB Pyodide core plus 2 MB of wheels). That's about **8.7 MB gzipped**, istanbul included. The brief guessed "tens of MB", but it's smaller.
- **Speed:** cold load about 1.7 s, then about 2.1 s for a 4-test run on the container. Phone speed is unverified.
- Lines run at import time get an empty context. Phase 3 should label them "run at import".

## (b) JavaScript

- **istanbul-lib-instrument 6.0.3**, bundled for the browser with esbuild (1.3 MB). It needed shims for `path`, `crypto` and `process`. I picked **@babel/parser** for Phase 2 because istanbul already ships Babel, so one parser covers both.
- In-memory CommonJS loader, Jest-style `describe/it/test`, and `expect` with toBe, toEqual, toBeTruthy, toContain, toHaveLength, toThrow, `.not`, `.resolves` and `.rejects`.
- **Per-test coverage works:** counters reset before each test. `require('fs')` fails that one test with a clear reason.
- Instrument with `coverageGlobalScopeFunc: false`. Otherwise istanbul injects `new Function("return this")`.
- ESM `import/export` between uploaded files is **not in the spike**. It's a Phase 3 item (Babel transform to CJS).

## (c) Sandbox and privacy: what I learned

- **Key finding:** a Worker loaded from a normal URL does **not** get the page's `<meta>` CSP. GitHub Pages sends no CSP header, so with the stubs off, **8 canary requests reached the sink**. A Worker created from a **blob: URL inherits** the meta CSP. With the stubs off there, CSP alone blocked everything (0 hits). **Lynceus must start every worker from a blob: URL** (`boot.js`).
- With full defenses, every path failed loudly with "network blocked by Lynceus" and the sink saw 0 hits. The paths tested were fetch, XHR, WebSocket, EventSource, importScripts, nested Worker, prototype and constructor-walk fetch, Python `import js / pyodide.* / _pyodide / pyodide_js / micropip`, socket, urllib, http.client, and two garbage-collector tricks to recover the hidden `js` module.
- **Dynamic `import()`** can't be stubbed because it's syntax. CSP blocks it before any bytes leave, and the browser logs it as "(blocked:csp)". So the Network tab will show **one blocked entry**, not literally zero rows. The acceptance test should count requests *sent* (sink log), not rows.
- **CSP directives used:** `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'`
  - Pyodide needs only `'wasm-unsafe-eval'`. It passed without `'unsafe-eval'`.
  - The JS runner **needs `'unsafe-eval'`** (or `blob:` in script-src) to run uploaded code. Without it the test file can't load. Neither choice weakens network blocking, because `connect-src` still governs every request. I'll pick one in Phase 3.
- Not covered by the spike: timeouts and OOM (Phase 3), and `frame-ancestors`, which a meta tag can't set.

## (d) Hosting

- From Hermes docs (`docs/HANDOFF_2026-11-19_career-fold-jgb-portfolio-live.md`): scottchristensen.dev is **Porkbun static hosting** via GitHub Connect, DNS on Porkbun. Unverified live, because the build box can't reach the domain.
- **Decision (Scott, 2026-11-22):** `lynceus.scottchristensen.dev` on GitHub Pages. Consequences:
  - Vite `base: '/'`, service-worker scope `/`, manifest `start_url: '/'` (replaces `/lynceus/` in §8).
  - Needs: GitHub repo `lynceus` with Pages on, custom domain set, and a **CNAME record at Porkbun**: `lynceus` → `<owner>.github.io`. Then Enforce HTTPS.
  - **Open:** which GitHub account owns it? Hermes publishes as `erasmus707bot-dev`.
  - GitHub Pages serving `.wasm` as `application/wasm`, and its file limits (largest file here is 9.6 MB): **unverified**, so check on first deploy.
