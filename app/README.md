# Lynceus app

```bash
cd ~/Lynceus/app
npm ci --legacy-peer-deps   # npm 10.9 crashes on an optional Vitest peer without this flag
npm run dev       # http://localhost:5173  (no CSP and no service worker in dev)
npm test          # unit tests (Vitest)
npm run check     # type check (svelte-check)
npm run build     # production build -> dist/ (CSP meta + service worker file list added)
npm run e2e       # end-to-end checks against dist/ (needs Playwright + Chromium)
```

Needs Node 20.19+ or 22.12+ (Vite 8).

## Privacy rules built in so far

- User code lives in page memory only. Closing the tab forgets it.
- **Clear everything** wipes memory, the IndexedDB session, sessionStorage, and turns Remember off.
- **Remember this session on this device** is opt-in and saves to IndexedDB. A "● Remembering" pill shows while it's on.
- localStorage holds settings only (whitelisted fields: theme, size limits, remember flag).
- The service worker caches the built app files only (list generated at build time) and ignores other origins.
- CSP is delivered by `<meta>` in the build (see `vite.config.ts`, verified in Phase 0).

## Phase 2 notes

- `npm run dev` and `npm run build` first copy Pyodide from `node_modules/pyodide` into `public/vendor/pyodide/` (gitignored). Run `npm ci --legacy-peer-deps` again after pulling, because Phase 2 added dependencies.
- Python support (about 13.5 MB) downloads only after you press **Download Python support** the first time Python code is loaded. It is then kept in its own cache (`lynceus-pyodide-<version>`), so later visits and offline use skip the prompt.
- Drag files or a folder anywhere on the Input screen. Dropping a single file on the paste box fills the box instead.
- Role rules live in `rules/javascript.json` and `rules/python.json`. Edit them to teach Lynceus new I/O or pure functions.
- Static hosts must serve `.mjs` as JavaScript and `.wasm` as `application/wasm` for Python to load.

## Phase 3 notes (tests)

- `npm run vendor` also downloads the pinned pytest/coverage wheels from PyPI (sha256-checked, see `scripts/wheels.json`). That needs internet at build time only. Offline build: `node scripts/vendor-wheels.mjs --from <folder with the .whl files>`. Behind a proxy: `NODE_USE_ENV_PROXY=1`.
- User code runs only in `src/workers/sandbox.worker.ts`: a fresh worker per run, started from a blob: URL, network stubbed before any user code (`src/sandbox/guard.ts`, `py_guard.py`).
- Time limits (Tests tab, "Time limits"): 10 s per test and 60 s per run by default. A hung test is reported by name and the rest run again in a new worker.
- JS runner: ES modules and `require` between uploaded files, `describe/it/test`, hooks, and the matchers listed in `src/sandbox/expect.ts` (pinned by `tests/fixtures/expect-snapshots.json`). Node built-ins, npm packages, `jest.fn` and snapshots fail that one test with a reason.
