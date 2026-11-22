# Lynceus Phase 1 report (scaffold)

*Built and tested 2026-11-22 in a cloud container (headless Chromium). Not yet run on gandalf.*

## Built

- **App scaffold** in `app/`: Svelte 5.57.3, TypeScript 6.0.3, Vite 8.3.6, fflate 0.7.5. Every version is pinned and more than 2 weeks old.
  - **Why Svelte:** it compiles to small bundles with no runtime diffing, which suits phones, and it has scoped CSS for the two themes.
  - **Build size:** 25 KB of JS and 2 KB of CSS, gzipped.
- **Sticky nav:** the theme toggle (default light, saved in localStorage), the **Clear everything** button, and a "● Remembering" pill while Remember is on.
- **Tabs:**
  - Phones get a bottom tab bar: Input · Queue · Code · Tests · Report.
  - Wide screens show the tabs in the nav instead.
  - Every tab except Input shows which phase builds it.
- **Input screen:**
  - **Paste box** with language auto-detect (tagged **heuristic**, with a "not sure" note) and a manual override
  - **Multi-file upload** and **.zip upload**. Folder paths are kept, and a single wrapping top folder is stripped.
  - Optional **tests**, **diff** and **spec** boxes
  - Every file left out is listed with its reason: wrong type, binary, over 2 MB, inside `node_modules`, `__MACOSX` and so on.
- **Size limits** (configurable in settings): a warning above 5,000 lines, and a hard stop above 30,000 lines or 200 files, which disables the button.
- **Data retention (§6.9):**
  - By default, everything stays in memory only.
  - The opt-in Remember switch saves to IndexedDB.
  - **Clear everything** deletes the database, clears sessionStorage and memory, and turns Remember off.
  - When Remember is off, any stale database is also deleted on startup.
- **PWA:**
  - The manifest uses `start_url` and scope `./`.
  - The service worker caches only the **built app files**, from a list generated at build time, with a content-hash version. It ignores other origins.
  - The CSP `<meta>` from Phase 0 is added to the **build only**, because Vite's dev server needs inline scripts and a websocket.
- **Theme colors** are the brief's cream/navy and `#0d1520`/`#e8dfc8`/gold. Every text pair checked passes **WCAG AA**: the lowest is 6.0:1, against a 4.5:1 requirement.

## Tests

- **Unit tests (Vitest): 25/25 pass.** They cover language detection, test-file detection, line counting, size limits, path cleanup, zip reading (folders, skip reasons, broken zip), the IndexedDB session, and the settings whitelist.
- **Type check (svelte-check):** 0 errors and 0 warnings.
- **End-to-end tests (Playwright, against the production build): 21/21 pass.** Log: `app/tests/e2e/last-run.json`, regenerated on each run.
  - CSP is present, with no violations
  - Light by default, and dark persists after a reload
  - Paste, auto-detect and load all work
  - **Acceptance #9:** a reopened tab shows no previous code. The page, localStorage, sessionStorage, IndexedDB and caches were all checked for a canary string.
  - Zip upload keeps folders and lists skipped files. Multi-file upload works.
  - The 5,000-line warning and the 30,000-line hard stop both work.
  - With Remember on, the session comes back after reopening the tab. **Clear everything** wipes it, and nothing comes back after a reload.
  - At 360 px wide, there's **no horizontal scroll on any tab** in either theme
  - It **works offline** after the first load, with the server stopped and the browser offline
  - **Zero requests** to any other origin

## Notes and open items

- **Font size:** I read "17pt+" as 17 CSS px, the same as iOS's 17 pt body. Body text is **18 px** and code is **16 px**. Say if you meant print points, which would be about 23 px.
- Install with `npm ci --legacy-peer-deps`, because npm 10.9 crashes on an optional peer of Vitest. I couldn't write an `.npmrc` to your NUC (the remote tools block that file), so the flag has to be typed.
- Vitest's jsdom environment breaks fflate's type checks, so the zip unit tests run in the node environment. Real-browser zip upload is covered by the end-to-end tests.
- **Not run on gandalf yet.** It needs Node 20.19+ (Vite 8). The device shell has node, but its version is unconfirmed.
