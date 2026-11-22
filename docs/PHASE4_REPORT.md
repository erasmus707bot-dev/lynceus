# Lynceus Phase 4 report (reading queue and the four passes)

*Built and tested 2026-11-22 in a cloud container (headless Chromium). Not yet run on gandalf.*

## Built

- **Queue tab ("Read these first"):**
  - Every function gets a 0–100 risk score. The top 5 are listed first, then the rest.
  - Tap a score to see each factor: the raw fact, the value, its scale, the weight and the points.
  - Uses your approved scales and default weights (complexity 30, nesting 20, side-effect lines 20, uncovered 20, diff 10). Bands: high is 67+, medium 34–66, low below 34.
  - With no tests run or no diff, the missing factor shows "not used", its weight is shared out over the others, and a note says so.
  - **Changed functions only** filter when a diff is loaded.
  - **Risk weights** panel; weights are saved in settings.
  - Functions in test files are left out (they're evidence, not code under review).
- **Diff:** unified diffs are matched against the loaded code. A hunk that doesn't match is listed under **Diff problems** with the exact line, and isn't used. Nothing is guessed.
- **Analyzers (JS and Python):** cyclomatic complexity per function, every call site (marked in your code, known from the rule list, or unresolved), and unreachable code (after return/throw/raise/break/continue, or under `if (false)` / `while False`).
- **Built-in constructors are now pure:** `new Error(…)`, `ValueError(…)`, `Map`, `Set` and similar. This fixes the **U** on `throw new Error` from the Phase 3 screenshot.
- **Code tab passes** (a switch above the code):
  - **Lines:** the Phase 2/3 view.
  - **Shape:** files, classes and functions with their scores. Pick one to see who calls it and what it calls.
  - **Flow:** lines the tests ran get a green edge. Other lines are dimmed and labelled "not run by the provided tests", once per stretch in each function. Unreachable code is labelled **unreachable**, and tapping it gives the reason. With no test run, a banner says only unreachable code is marked.
  - **Intent:** tap a spec bullet, then link functions or tests by hand. Word-match suggestions are marked heuristic and count only after you confirm them. A **Possible scaffolding** list shows functions no test reached that no bullet links to.
- **How to read this** now explains the passes, risk bands and scaffolding.

## Tests

- **Unit tests (Vitest): 187/187 pass** (19 new: metrics, unreachable code, call sites, risk scores worked out by hand, diff matching, call graph, spec suggestions, scaffolding, coverage labels).
- **Type check:** 0 errors, 0 warnings.
- **End-to-end (Playwright, production build): 80/80 pass.** New Phase 4 checks:
  - Top 5 plus the rest, with the busiest function first. The breakdown shows every factor and the total. The no-test-evidence note appears.
  - The diff factor on a changed function, a mismatched hunk reported, and "Changed functions only".
  - Shape: an unknown call shown as unresolved, plus callers.
  - Flow: the banner without tests, the unreachable label and its reason, and run and not-run lines after tests.
  - Intent: no scaffolding guesses before tests, confirming a suggestion, a hand link, and scaffolding that drops a function once it's linked.
  - Phone (360 px): Queue, Shape and Flow have no horizontal scroll.

## Sizes

- Main page JS: 48 KB gzipped (was 38 KB).

## Flags

- **Retention:** `retention.ts` is unchanged. Spec links live on the workspace, so they're saved only when **Remember** is on and cleared with everything else.
- **One-line arrow functions in Flow:** coverage is per line. `export const neg = (a) => -a;` runs at import, so Flow shows that line with a green edge even if no test called `neg`. The scaffolding list does count it as untested (it flagged `sub` and `neg` in the test project); only the Flow edge is misleading.
- **Function headers in JS:** a `function f() {` line isn't a statement in istanbul, so Flow leaves it unmarked.
- **Call names:** a call on an expression's result (like `helper(n).toFixed(2)`) is listed as `(expression)()`.
- **Score feel:** with the approved scales, a fairly busy function (complexity 5, depth 3, 2 side effects) scores 35, which is medium. If that feels low on real code, the weights panel or the scales can be changed.

## Screenshots

`docs/phase4-queue.png`, `docs/phase4-shape.png`, `docs/phase4-flow.png`, `docs/phase4-intent.png`. Phone: `app/tests/e2e/phone-queue.png`, `phone-shape.png` (not committed).
