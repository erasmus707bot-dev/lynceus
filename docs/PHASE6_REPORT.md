# Lynceus Phase 6 report (demo kit, deploy, user guide, acceptance sweep)

*Built and tested 2026-11-22 in a cloud container (headless Chromium). Not yet run on gandalf, and not deployed.*

Choices applied: a **"Try a demo"** button in the app, plus the files in `demo/`. A **GitHub Actions** workflow publishes the site. I created no repository, pushed nothing and changed no DNS.

## Built

- **Two demo projects**, `demo/python/` (warehouse stock) and `demo/javascript/` (shop cart). Each has:
  - deep nesting (depth 6)
  - branches no test runs
  - a scaffolding function (no test and no spec bullet)
  - a broad catch
  - an obviously fake secret
  - tests that pass, plus one that fails because of a real bug the spec exposes
  - a 5–6 bullet `SPEC.md` and a small `change.diff`
  - `demo/README.md` lists every planted problem.
- **Input tab:** a new **"New here? Try a demo"** card with **Python demo** and **JavaScript demo** buttons. One tap fills in the files, spec and diff and loads them. The demos are bundled, so they work offline. The main bundle grew by about 3 KB gzipped (to 61 KB).
- **Deploy:**
  - `.github/workflows/deploy.yml`: install, unit tests, type check, build, publish to Pages.
    - Pyodide comes from npm (checked by the lock file); the wheels are sha256-checked.
    - The four GitHub actions are pinned to commit SHAs. All are more than 2 weeks old; the newest, setup-node v7, is from 2026-10-07.
  - `app/public/CNAME`.
  - `docs/DEPLOY.md`: repository steps, the Porkbun record, and checks for HTTPS, content types and offline use.
- **`docs/USER_GUIDE.md`:** one printable page.
- **Tests:**
  - 3 new unit tests (`tests/unit/demo.test.ts`). They check that each demo's diff still applies and that the planted problems are found.
  - 11 new end-to-end checks, including the demos offline.
  - `tests/e2e/demo-probe.mjs` prints the full Queue for a demo.

## Hand-computed top 5 (acceptance tests 5 and 6)

I wrote these numbers from the code **before** opening the Queue. The Queue then matched every name, every order and every score, and the end-to-end test now checks it.

Setup: tests run, diff supplied, default weights. So all five factors count: complexity 30, nesting 20, side effects 20, uncovered 20, diff 10. Points = weight × value.

<details>
<summary>JavaScript: applyDiscounts 52, shippingCost 33, exportCartCsv 32, sendReceipt 23, refundOrder 20</summary>

1. **applyDiscounts = 52**
   - complexity 12: 11 decision points (8 if, 1 for, 2 &&) → (12−1)/10, capped at 1 → **30**
   - depth 6 (if › for › if › if › if › if) → capped at 1 → **20**
   - side-effect lines 0 (only the local `discount` changes) → **0**
   - 2 of 17 statements not run (the 10% book line, the gift-card `continue`) → 20 × 0.118 → **2.4**
   - not in the diff → **0**
   - total 52.4 → **52**
2. **shippingCost = 33**
   - complexity 4 → 30 × 0.3 → **9**
   - depth 1 → 20 × 0.2 → **4**
   - side effects → **0**
   - 2 of 4 statements not run (Canada and elsewhere) → **10**
   - in the diff → **10**
3. **exportCartCsv = 32**
   - complexity 2 → **3**
   - depth 1 → **4**
   - side-effect lines 2 (`rows.push`, `console.log`) → 20 × 0.25 → **5**
   - 5 of 5 statements not run → **20**
4. **sendReceipt = 23**
   - side-effect line 1 (`fetch`) → **2.5**
   - 1 of 1 statement not run → **20**
   - total 22.5 → **23**
5. **refundOrder = 20**
   - 1 of 1 statement not run → **20**

Below the top 5: cartSubtotal 14, checkout 12, lookupCoupon 10, lineTotal 0.
</details>

<details>
<summary>Python: allocate_orders 50, export_stock_report 39, load_config 36, reserve 28, order_value 23</summary>

1. **allocate_orders = 50**
   - complexity 7 (3 for, 3 if) → 30 × 0.6 → **18**
   - depth 6 → **20**
   - side-effect lines 4 (the stock `-=`, `setdefault().append`, `log.warning`, `results[…] =`) → 20 × 0.5 → **10**
   - 1 of 13 statements not run (`log.warning`) → **1.5**
   - total 49.5 → **50**
2. **export_stock_report = 39**
   - complexity 3 → **6**
   - depth 2 → **8**
   - side-effect lines 2 (`append`, `print`) → **5**
   - 6 of 6 not run → **20**
3. **load_config = 36**
   - complexity 2 → **3**
   - depth 2 (try › with) → **8**
   - side-effect lines 2 (`open`, `json.load`) → **5**
   - 6 of 6 not run → **20**
4. **reserve = 28**
   - complexity 3 → **6**
   - depth 1 → **4**
   - side-effect lines 2 (`stock[sku] -=`, `history.append`) → **5**
   - 1 of 7 not run (`raise`) → **2.9**
   - in the diff → **10**
   - total 27.9 → **28**
5. **order_value = 23**
   - complexity 3 → **6**
   - depth 1 → **4**
   - side effects → **0**
   - 1 of 6 not run (express fee) → **3.3**
   - in the diff → **10**
   - total 23.3 → **23**

Below the top 5: sync_to_erp 20, restock_needed 0.
</details>

### Weight check: one ranking looks odd (your call, nothing changed)

- Both rankings look right for "read this first". The deep, branchy functions lead, and the untested scaffolding comes next.
- **The odd one:** in each demo, the function whose test **fails** ranks low.
  - Python `restock_needed` scores **0** and comes last.
  - JavaScript `applyDiscounts` is first, but only because of its complexity.
- **Why:** the score has no factor for "a failing test ran this function". A failing test is the strongest sign of a bug, yet it doesn't move the score.
- **Changing weights wouldn't fix it.** It would need a new factor, for example "run by a failing test", worth 1 or 0. That changes the scale you approved in Phase 4, so I've left it alone.

## Acceptance sweep (all 12)

All 109 end-to-end checks and all 211 unit tests pass, and svelte-check reports 0 errors and 0 warnings. "Cloud" means I tested it in headless Chromium against a local server; it still needs a check on the real site.

1. **Offline after first load, Python included: pass (cloud).** The server was stopped and the browser set offline, then Python analysis, Python tests and the demo all ran. *Verify on your phone after deploy (DEPLOY.md step 5).*
2. **Zero network requests: pass (automated).** No request went to any other origin, and nothing reached the sink. *The DevTools Network tab check is for gandalf.*
3. **Planted exfiltration test fails loudly in both languages: pass.**
4. **Infinite loop stopped at the timeout and named: pass**, in both languages.
5. **Python sample: pass.** Tests ran (6 passed, 1 failed), untested lines are dimmed and labelled, and the top 5 matches the hand list.
6. **JS sample: pass.** Tests ran (7 passed, 1 failed), untested lines are dimmed and labelled, and the top 5 matches the hand list.
7. **Every highlight shows its rule, evidence and certainty on tap: pass.**
8. **Unknown calls never pure; untested never "dead": pass.**
9. **Reopened tab with retention off shows no code: pass.**
10. **6-inch phone, both themes, no sideways scroll: pass (cloud, 360 px emulated).** *Verify on your phone.*
11. **Diff mode limits to changed functions; mismatched hunks reported: pass.**
12. **Report masks secrets, no code unless opted in: pass.**

**Still unverified:** that GitHub Pages serves `.wasm` as `application/wasm` and `.mjs` as JavaScript. DEPLOY.md step 5 has the two `curl` checks.

## Files changed

<details>
<summary>New and changed files</summary>

- New: `demo/README.md`, `demo/python/{inventory.py, test_inventory.py, SPEC.md, change.diff}`, `demo/javascript/{cart.js, coupons.js, cart.test.js, SPEC.md, change.diff}`
- New: `.github/workflows/deploy.yml`, `app/public/CNAME`
- New: `app/src/lib/demo.ts`, `app/tests/unit/demo.test.ts`, `app/tests/e2e/demo-probe.mjs`
- New: `docs/DEPLOY.md`, `docs/USER_GUIDE.md`, `docs/PHASE6_REPORT.md`, `docs/phase6-demo-queue.png`, `docs/phase6-demo-report.png`
- Changed: `app/src/components/InputScreen.svelte` (demo card), `app/vite.config.ts` (dev server may read `../demo`), `app/tests/e2e/run.mjs` (Phase 6 checks), `app/README.md` (Phase 6 notes)
- Not deleted: `Placeholder.svelte` is still unused and still waiting for your decision.
</details>
