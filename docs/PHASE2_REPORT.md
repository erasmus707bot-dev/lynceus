# Lynceus Phase 2 report (read the code)

*Built and tested 2026-11-22 in a cloud container (headless Chromium). Not yet run on gandalf.*

## Built

- **Parsing in a worker.** All analysis runs in one Web Worker started from a `blob:` URL, so it stays under the page CSP (the Phase 0 finding).
  - **JavaScript:** @babel/parser 7.29.13 with scope tracking (local, outer, module, undeclared).
  - **Python:** the standard `ast` module running inside Pyodide 314.0.7, self-hosted.
- **Roles on every statement**, shown as a gutter letter:
  - **M** state mutation, **I** I/O or side effect, **C** control flow, **P** pure computation, **U** unknown call.
  - Every role is tagged **certain** or **heuristic**, and carries evidence: the rule id, a plain sentence, and "from the syntax tree".
  - An unknown call is never called pure. Calls to your own functions inherit that function's role.
  - Rules live in editable JSON files: `app/rules/javascript.json` and `app/rules/python.json`.
- **Code view:**
  - Calm by default, with no colour until you press a role chip. Each chip shows a count.
  - Heuristic marks get a dashed outline and a lighter tint, so they never look as sure as certain ones.
  - Nesting guides, one colour per level, and a **⚑** flag on lines deeper than the limit (default 3, in settings).
  - Fold any block. A folded block shows a summary from the syntax tree, such as "for loop · 3 branches · calls console.log()".
  - A Wrap toggle (on by default below 760 px) and a file picker for multi-file input.
- **Evidence pane:**
  - Tap or press Enter on a line to see its roles, certainty, evidence and nesting depth.
  - **Side by side** on screens 1100 px and wider, as a bottom sheet on phones. Escape closes it.
  - With nothing selected it shows **How to read this**, the legend.
- **Python support on demand (your choice "1"):**
  - The first time Python is loaded, a prompt shows the download size (13.5 MB) with **Download Python support** or **Skip Python files for now**.
  - After that it's cached in its own service-worker cache, so later visits and offline use skip the prompt. The app's own precache never includes it.
- **Drag and drop** (your request): drop files or whole folders anywhere on the Input screen. Dropping one file on the paste box fills the box and its file name.
- **Colours:** new role tokens for both themes. Every pair passes WCAG AA; the lowest is 5.0:1.

## Tests

- **Unit tests (Vitest): 102/102 pass.**
  - 44 for the JavaScript analyzer and line model.
  - 33 that run the real `analyze.py` inside Pyodide in Node.
  - The 25 Phase 1 tests still pass.
- **Type check (svelte-check):** 0 errors and 0 warnings.
- **End-to-end tests (Playwright, production build): 40/40 pass.** Every page and worker is watched for CSP violations and errors.
  - The 21 Phase 1 checks still pass.
  - New: drag-drop onto the page and the paste box, gutter letters I and U, calm default, chip tint, evidence pane, ⚑ flag, fold summary, Escape.
  - Python: the consent prompt shows the size, `pick.py` is analysed, Pyodide is cached by the service worker, and Python works **offline** with no second prompt.
  - Phone (360 px): the bottom sheet opens with no horizontal scroll.
- **Dev mode** (`npm run dev`) checked: JavaScript and Python both analyse.
- **Size:** main JS 33 KB gzipped; analysis worker 94 KB gzipped. Pyodide (about 8.7 MB gzipped) loads only when you agree.

## Known limits

- `module.exports = …` shows as **M** (it assigns a property).
- An `else if` chain counts each path as a branch, so `if / else if / else` reads "3 branches".
- In JavaScript, calling a nested function declared further down the same function may show **U**, because hoisting isn't modelled yet.
- Python `map(f, xs)` and similar show as **pure, heuristic**, since `f` could do anything.
- Library rules like `fs.*` are **heuristic** by design. Lynceus doesn't yet check that `fs` really came from `require('fs')`.
- **Unverified:** that GitHub Pages serves `.mjs` and `.wasm` with the right types. It should, but I'll confirm in the hosting step.

## Screenshot

`docs/phase2-desktop-code.png` (1440 px wide, side-by-side pane). Phone view: `app/tests/e2e/phone-code.png` (not committed).
