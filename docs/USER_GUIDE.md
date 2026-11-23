# Lynceus: one-page guide

**Lynceus helps you read code an AI wrote, without sending it anywhere.** It runs entirely in your browser, works offline, and reviews Python, JavaScript and TypeScript. It uses no AI. Every mark it makes comes from the syntax tree, a test run or your diff, and says how sure it is.

## 1. Load code (Input tab)

- **First time?** Press **Python demo** or **JavaScript demo**.
- Otherwise paste one file, or upload files, a folder or a `.zip`. You can also drag them onto the page.
- **On Android**, once Lynceus is installed, choose **Lynceus** in any app's **Share** menu to send it code or a file. It lands on the Input tab; nothing is loaded until you press Review. (iPhone doesn't offer this.)
- Optional: add tests, a **git diff** (to focus on what changed) and a **spec** (one bullet per line).
- Press **Review this code**. Python needs a one-time download of about 14 MB, and the app asks before it starts.

## 2. Run the tests (Tests tab)

- Press **Run tests**. Tests run in a locked-down sandbox with no network.
- Every test is listed with its result. Failures show the assertion message.
- If there are no tests, the tab says so. Lynceus never guesses coverage.
- **Python packages:** if a test needs a package from PyPI (for example `requests`), tick **Package downloads** on this tab. Lynceus reopens in a mode that may contact PyPI, shows the package names it found, and sends only those names, only when you press the button. Your code is never sent. Untick to go back to the fully offline page.

## 3. Read the riskiest code first (Queue tab)

- Functions are ranked 0–100 by complexity, nesting, side effects, untested lines, the diff, and whether a **failing test** ran them.
- Tap a score to see exactly how it was worked out. Change the weights under **Risk weights**.
- Tick **Reviewed** as you go, and add a note if you like. The progress bar is weighted by risk.

## 4. Read the code (Code tab)

Four passes, top of the tab:

- **Lines:** letters in the gutter show what each line does: **M** mutation, **I** I/O, **C** control flow, **P** pure, **U** unknown call. Tap a line for the rule and evidence. **⚠** marks a finding.
- **Shape:** each function's outline, and who calls what.
- **Flow:** which lines the tests ran. Untested lines are dimmed and labelled "not run by the provided tests", never "dead".
- **Intent:** link spec bullets to functions and tests. Code with no test and no spec link is marked **possible scaffolding**.

**Lens:** press **Lens**, then tap a name to light up every read (R) and write (W) of that variable, or the callers of a function. Press **Esc** to clear.

## 5. Export (Report tab)

- **Download Markdown**, or **Print / Save as PDF**.
- The report has no source code unless you tick **Include code excerpts**. Anything that looks like a secret is always masked.

## Marks you'll see

- **certain:** proved from the syntax tree or the test run.
- **heuristic** (dashed): a good guess, such as a library call rule or a name that looks like a password. Check these yourself.

## Privacy

- Nothing is uploaded. After the first visit the app works with no network at all. The one exception is **Package downloads**, which is off unless you turn it on, and sends package names only.
- By default nothing is kept after you close the tab. **Remember this session** (Input tab) keeps your code in this browser only.
- **Clear everything** (top bar) wipes it all.
