# Lynceus Phase 7 report (v1.1: failing-test factor, TypeScript, package downloads, Share to Lynceus)

*Built and tested 2026-11-22 in a cloud container (headless Chromium). Not yet on gandalf or the live site.*

## Built

1. **Polish**
   - The risk score has a new sixth factor, **"Ran during a failing test"**. It is worth 1 if a failed, timed-out or crashed test ran any line of the function, and 0 otherwise.
   - New default weights: complexity 25, nesting 15, side effects 15, uncovered 15, diff 10, failing 20.
     - Saved weights that match the old defaults move to the new ones.
     - Custom weights keep their values and get failing 20.
   - `Placeholder.svelte` is deleted.
2. **TypeScript**
   - `.ts`, `.tsx`, `.mts` and `.cts` files are analysed and their tests run.
   - Type-only lines (interfaces, type aliases, `declare`) get no role letter.
   - `import './x.js'` also finds `x.ts`. `.d.ts` files are skipped.
   - New dependency: `@babel/plugin-transform-typescript` 7.29.9. One of its sub-dependencies is pinned to an older version (7.29.7) because the newest was under 2 weeks old.
3. **Package downloads (Python only, off by default)**
   - A toggle on the Tests tab reopens the app as `packages.html`. That page's policy also allows `pypi.org` and `files.pythonhosted.org`. The normal page still can't reach them at all.
   - Your loaded code comes with you across the switch. It is held in the tab only and deleted once read.
   - The names box is filled in from the tests' missing imports. Nothing is sent until you press the button, and only package names are sent.
   - Only pure-Python wheels are used, and each one's sha256 is checked against PyPI's listing. Their dependencies are followed. Limits: 30 packages, and 20 MB per wheel.
   - Downloaded wheels stay in memory for the tab. The test sandbox is still network-locked.
   - A "● Package downloads on" pill shows in the top bar while it's on.
4. **Share to Lynceus (Android, installed app only)**
   - Lynceus appears in Android's Share menu. Shared text goes to the paste box, and shared `.py`/`.js`/`.ts`/`.zip` files go to the file list. Anything else is listed with a reason. A shared link alone gets an explanation, because Lynceus never goes online.
   - The service worker holds the share in a separate cache only until the page opens. The page then deletes that cache and removes `?shared=1` from the address bar.
   - "Clear everything" also deletes it.

## Changes from the plan (please note)

- **No micropip.** The plan said I'd vendor micropip. Instead, Lynceus's own page code fetches and checks the wheels, then hands them to the sandbox. Uploaded code never gets network access, and every download is sha256-checked. This also means nothing new was vendored.
- **Share target on iPhone:** Apple doesn't support web share targets, so the Share menu entry only appears on Android (Chrome) after installing.
- **Not verified:** whether Android's share sheet offers Lynceus for `.py` files from every app. Some apps label them with an unusual file type. The manifest accepts the code extensions plus `text/*` and `application/octet-stream` to be generous.
- **Not verified:** a real phone share. The test posts to `./share` through the service worker, the same way Android does, but no phone was involved.

## Demo hand check with the new weights

I worked these out before running the Queue. The Queue matched every name, order and score, and the end-to-end test now checks the top 6.

- **JavaScript:** applyDiscounts **62** (+20 failing test), shippingCost 28, exportCartCsv 24, sendReceipt 17, refundOrder 15, cartSubtotal 11, then checkout 9, lookupCoupon 8, lineTotal 0.
- **Python:** allocate_orders 39, export_stock_report 30, load_config 27, reserve 24, order_value 21, **restock_needed 20** (was 0 and last), sync_to_erp 15.

**The odd ranking from Phase 6 is only partly fixed.** restock_needed, whose test fails, now ranks 6th of 7 instead of last. It is a one-line function, so the failing factor (20) is all it scores. Raising the failing weight to about 25 would put it above order_value. That's your call. You can try it under **Risk weights**.

## Tests

- **Unit:** 232 pass (up from 211). New files: `ts.test.ts`, `packages.test.ts`, `share.test.ts`, plus new cases in `review.test.ts` and `py-runner.test.ts`.
- **Type check:** svelte-check reports 0 errors and 0 warnings.
- **End-to-end:** all 129 pass (up from 109; log in `docs/logs/phase7-e2e.log`). New checks cover:
  - the failing factor in both demos
  - TypeScript tests and coverage
  - package downloads with PyPI mocked: the strict page is blocked, nothing is sent on toggle, the sha256 is checked, the test passes after download, and unticking goes back
  - share pick-up and deletion
- Still true: **zero requests to any other origin** on the normal page.

## Files changed

<details>
<summary>New, changed and deleted files</summary>

- New: `app/src/analysis/ts.ts`, `app/src/lib/packages.ts`, `app/src/lib/share.ts`, `app/src/components/PackagePanel.svelte`
- New tests: `app/tests/unit/{ts,packages,share}.test.ts`
- Changed (analysis and runner): `analysis/js/adapter.ts`, `analysis/js/extras.ts`, `sandbox/{js-runner,detect-tests,protocol,py-host,client}.ts`, `sandbox/py_runner.py`
- Changed (app): `review/risk.ts`, `lib/{review.svelte,session.svelte,detect,files,types}.ts`, `main.ts`, `components/{InputScreen,TestsTab,QueueTab,Nav}.svelte`
- Changed (build and PWA): `vite.config.ts` (writes packages.html), `public/sw.js`, `public/manifest.webmanifest`, `package.json`, `package-lock.json`
- Changed (tests and docs): `tests/unit/{review,checks-report,files,js-runner,py-runner}.test.ts`, `tests/e2e/run.mjs`, `app/README.md`, `docs/USER_GUIDE.md`
- Deleted: `app/src/components/Placeholder.svelte` (you approved this)
</details>
