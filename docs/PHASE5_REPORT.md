# Lynceus Phase 5 report (lens, extra checks, review progress, export)

*Built and tested 2026-11-22 in a cloud container (headless Chromium). Not yet run on gandalf.*

Choices applied: secrets are masked, with tap-to-reveal, and never appear in exports. All of Phase 5 was built in one pass.

## Built

- **Extra checks (§6.7), in both languages.** Each finding has a rule id, its evidence source, and a certain or heuristic tag.
  - Unused functions, variables and imports.
    - A JS function that is exported, or a top-level Python function, is **heuristic**: code outside the upload could use it.
    - A decorated Python function is also heuristic.
    - Tuple unpacking, `__init__.py` re-exports and imports inside `try` are heuristic too.
  - Duplicated blocks of 6+ lines that share a syntax-tree shape (names and constants ignored), within and across files.
  - Unreachable code.
  - Bare `except:`, `except Exception` and empty `catch {}`. An empty `.catch(() => {})` is heuristic.
  - Mutable default arguments (Python).
  - `==` instead of `===` (JS). `== null` is heuristic, since it's a common idiom.
  - Possible hardcoded secrets:
    - 9 known key formats are **certain**.
    - Name hints (`password = "…"`) and long random-looking strings are **heuristic**.
  - TODO, FIXME, XXX and HACK comments.
  - Placeholder bodies: `pass`, `...`, `raise NotImplementedError`, empty functions, "not implemented" throws. `@abstractmethod` and `@overload` stubs are left alone.
- **Where findings show:**
  - a **⚠** in the gutter
  - rule, evidence and certainty when you tap a line
  - "⚠ N findings" on each Queue item
  - the full list on the Report tab
- **Masked secrets:** the code view shows `sk_l••••` with a **show / hide** button for that one string. Exports never contain the value.
- **Lens (§6.6), off by default.**
  - Press **Lens**, then tap a name. Every read (**R**), write or declaration (**W**), and `+=`-style read-and-write (**RW**) of that exact variable lights up, and the rest dims.
  - It follows scope: a same-named variable in another function, block, class or comprehension stays dark.
  - Tap a function's first line (or its name) to keep only it, its callers and its callees bright. Calls into other files are listed as links.
  - Esc or **Clear lens** turns it off.
  - **Scope sources:**
    - JS uses Babel's own scope tracker: **certain**.
    - Python uses Lynceus's own pass for local, enclosing, global, nonlocal, class and comprehension scopes. Class and comprehension scopes, and files that use `exec`, `eval`, `locals()` or `import *`, are **heuristic**.
- **Review progress (§6.8):**
  - A **Reviewed** checkbox and a one-line note on each function, in the Queue and Shape views.
  - The Queue shows **% of risk-weighted code reviewed**: reviewed scores ÷ all scores.
- **Report tab:** summary, unreviewed high-risk functions, findings by check, test results, lines not run by the tests, review notes, spec coverage and files.
  - **Download Markdown.**
  - **Print / Save as PDF:** the print stylesheet hides the nav and buttons.
  - **No source code unless "Include code excerpts" is ticked.** Test failure messages are left out too, because they can quote code.
- **Fixed a Phase 4 bug:** Python call-graph links (Shape callers and callees between Python functions) never matched, because the worker renamed function ids but not call targets. Python callers and callees now link up.

## Tests

- **Unit tests: 208/208 pass** (21 new: JS bindings and checks, Python bindings and checks in real Pyodide, cross-file checks, masking, report).
- **Type check:** 0 errors, 0 warnings.
- **End-to-end (production build): 98/98 pass.** New checks:
  - JS: all 7 planted findings marked.
  - Secrets masked on the page; show and hide work.
  - Tapping a line shows the finding's rule and certainty.
  - Lens on a variable: W, RW and R marks, and the same-named variable in another function stays dark.
  - Function lens: callers and callees, including one in another file. Esc clears it.
  - Reviewed checkbox and note raise the progress figure.
  - Report contents.
  - **Acceptance #12:** the Markdown download has no code and a masked key by default. With excerpts ticked, code appears and the key is still masked.
  - The print view hides controls.
  - Python: 4 planted findings, the masked key, and a lens that lights only the right function's `data`.
  - Phone (360 px): Report and lens have no horizontal scroll.

## Sizes

- Main page JS: 58 KB gzipped (was 48 KB).
- Analysis worker: 221 KB gzipped, now including Babel's scope tracker. It is cached by the service worker like before.

## Flags

- **Dependency:** `@babel/traverse` 7.29.13 is now a direct dependency. It was already installed, at the version the overrides pin. Gandalf needs `npm ci --legacy-peer-deps` again.
- **"High-risk" in the report** means the reading queue's top 5 (score above 0) plus anything rated high (67+). With the approved scales, few functions reach "high", so the top 5 carries most of it. This can be tuned in Phase 6 with the demo samples.
- **Lens on methods:** `this.save()` and `obj.method()` aren't variable references, so tapping them does nothing. Tap the method's first line instead.
- **Python columns:** the lens converts Python's byte offsets to string positions. Older Phase 2 spans (blocks, statements) still use byte offsets, which only matters on lines with non-ASCII text before the code.
- **Secrets heuristics** can flag long IDs or hashes as "random-looking". They're tagged heuristic, and masking them is harmless.
- **Duplicates** ignore test files and very small runs (below about 25 syntax-tree nodes in JS, or 20 in Python).
- `Placeholder.svelte` is no longer used (every tab is real now). I left the file in place; say if you want it deleted.

## Screenshots

`docs/phase5-findings.png`, `docs/phase5-lens.png`, `docs/phase5-report.png`, `docs/phase5-print.png`. Phone: `app/tests/e2e/phone-report.png` (not committed).
