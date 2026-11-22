# Lynceus Phase 3 report (sandbox, test runner, per-test coverage)

*Built and tested 2026-11-22 in a cloud container (headless Chromium). Not yet run on gandalf.*

## Built

- **Tests tab:** a **Run tests** button, a progress bar with the running test's name, and a **Stop** button.
  - Results are grouped by file: passed, failed, error, skipped, timed out or crashed, each with its message and captured output.
  - Every test that couldn't run is listed with its reason. With no tests found, it says so plainly and coverage stays off.
  - Time limits (10 s per test, 60 s per run) can be changed on the tab.
- **Coverage on the Code tab:**
  - Lines no test ran are dimmed, striped, and labelled **"not run by the provided tests"** at the start of each stretch. Nothing is ever called "dead".
  - Tap a line to see exactly which tests ran it (with pass/fail), or "run only when the file was imported".
  - A **Coverage: on/off** toggle.
- **Sandbox (§5):**
  - A fresh, disposable worker per language per run, started from a blob: URL, so the page CSP applies.
  - Before any user code runs: fetch, XHR, WebSocket, EventSource, importScripts, sendBeacon, nested workers and BroadcastChannel are stubbed on the global and its prototypes. User code also can't post fake results to the page.
  - Python: `js`, `pyodide.*`, `micropip` imports are blocked; socket, urllib and http.client raise "network blocked by Lynceus".
  - **Watchdog on the page:** a hung or crashed test is named, its worker is killed, and the other tests run again in a fresh worker (up to 8 restarts). Out-of-memory errors are reported plainly.
- **Python:** pytest 9.2.0 and coverage 7.17.2 (plus 4 helpers) inside Pyodide, one coverage context per test. Missing packages say "Package downloads are off in v1".
- **JavaScript:** istanbul coverage with counters reset per test; ES modules converted to CommonJS (line numbers kept); `describe/it/test`, `.skip/.todo`, all four hooks, `done` callbacks and async; 20 Jest-style matchers plus `.not`, `.resolves`, `.rejects`.
- **Package-download toggle:** left out, as you chose. It's a v2 item.

## Tests

- **Unit tests (Vitest): 168/168 pass.** New: 9 for the JS runner, 5 that run the real Python harness in Pyodide, 48 for the matchers against the snapshot fixtures, and 4 for test detection and coverage labels.
- **Type check:** 0 errors and 0 warnings.
- **End-to-end (Playwright, production build): 60/60 pass.** New Phase 3 checks:
  - JS and Python: pass and fail with assertion text, Node built-in reason, dimmed and labelled untested lines, "Run by N tests" on tap, coverage toggle.
  - **Acceptance #3:** planted exfiltration tests fail loudly in both languages (8 JS paths, 6 Python paths). **Zero connections reached a sink server** on another port.
  - **Acceptance #4:** an infinite loop is stopped at the limit and named, in both languages, and the other tests still pass.
  - No-tests message, phone width with results (no horizontal scroll), and **Python tests running offline** after first use.
- **Dev mode** (`npm run dev`) checked with a JS test run.

## Sizes

- One-time Python download: **15.6 MB** (13.5 MB Pyodide + 2 MB wheels). The consent prompt now shows this.
- JS test runner chunk: 1.46 MB, **364 KB gzipped**. The page loads it only when JS tests run. The service worker does fetch it in the background on the first visit, so JS tests work offline. Say if you'd rather it be fetched only on first use.
- Main page JS: 38 KB gzipped (was 33 KB).

## Known limits and flags

- **Dependencies:** added istanbul-lib-instrument 6.0.3, @babel/core 7.29.13, @babel/plugin-transform-modules-commonjs 7.29.7. Some Babel sub-packages had releases under 2 weeks old, so `package.json` pins them back to 7.29.13 with `overrides`.
- `.each()` tables, `jest.fn` mocks, fake timers and snapshots are not supported. They fail the test with that reason.
- A test that hangs costs one rerun of the other tests. Python reruns also reload Pyodide (about 2 s in the container).
- Coverage is by statement line, not branch.
- Phone speed and memory with Python loaded in both workers: **unverified**.
- From the screenshot: `throw new Error(…)` shows **U** (constructor call treated as unknown). That's the Phase 2 rule set; I can add built-in constructors as pure in Phase 4.

## Screenshots

`docs/phase3-desktop-tests.png`, `docs/phase3-desktop-coverage.png`. Phone: `app/tests/e2e/phone-tests.png` (not committed).
