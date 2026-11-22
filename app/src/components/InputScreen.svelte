<script lang="ts">
  import { app, persist, setRemember, runAnalysis, resetTests } from '../lib/session.svelte';
  import { filesFromDrop, hasFiles, type Named } from '../lib/drop';
  import { acceptBytes, makeFile, mergeFiles, pastedName, readZip } from '../lib/files';
  import { guessLang } from '../lib/detect';
  import { checkLimits } from '../lib/limits';
  import type { SourceFile } from '../lib/types';
  import { getDemo, type DemoId } from '../lib/demo';

  let reading = $state(false);
  let error = $state('');

  const guess = $derived(app.pasteText.trim() ? guessLang(app.pasteText) : null);

  function draftFiles(): SourceFile[] {
    let files = [...app.pending];
    if (app.pasteText.trim()) {
      const lang = app.pasteLang === 'auto' ? (guess?.lang ?? 'python') : app.pasteLang;
      const name = app.pasteName.trim() || pastedName(lang, 'code');
      files = mergeFiles(files, [makeFile(name, app.pasteText, app.pasteLang)]);
    }
    if (app.testsText.trim()) {
      const lang = guessLang(app.testsText).lang;
      files = mergeFiles(files, [makeFile(pastedName(lang, 'tests'), app.testsText)]);
    }
    return files;
  }

  const draft = $derived(draftFiles());
  const limits = $derived(checkLimits(draft, app.settings));

  /** One pipeline for the file picker and drag-and-drop. Every rejected file is listed with a reason. */
  async function ingest(list: Named[]) {
    if (!list.length) return;
    reading = true; error = '';
    try {
      const got: SourceFile[] = [];
      for (const { path, file } of list) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (/\.zip$/i.test(file.name)) {
          const z = readZip(bytes);
          got.push(...z.files); app.pendingSkipped = [...app.pendingSkipped, ...z.skipped];
        } else {
          const r = acceptBytes(path, bytes);
          if (r.file) got.push(r.file); if (r.skipped) app.pendingSkipped = [...app.pendingSkipped, r.skipped];
        }
      }
      app.pending = mergeFiles(app.pending, got);
    } catch (err) {
      error = 'Could not read those files: ' + (err as Error).message;
    } finally {
      reading = false;
    }
  }

  async function onFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const list = Array.from(input.files ?? []).map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f }));
    await ingest(list);
    input.value = ''; // the browser's copy of the file list is released too
  }

  // ---- drag and drop ----
  let dragDepth = $state(0);
  let dragOverPaste = $state(false);
  const dragging = $derived(dragDepth > 0);
  function onDragEnter(e: DragEvent) { if (hasFiles(e)) { e.preventDefault(); dragDepth++; } }
  function onDragLeave(e: DragEvent) { if (hasFiles(e)) dragDepth = Math.max(0, dragDepth - 1); }
  function onDragOver(e: DragEvent) { if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } }
  async function onDrop(e: DragEvent) {
    if (!hasFiles(e) || !e.dataTransfer) return;
    e.preventDefault();
    dragDepth = 0;
    const onPaste = dragOverPaste;
    dragOverPaste = false;
    const list = await filesFromDrop(e.dataTransfer);
    // One code file dropped on the paste box: put its text in the box so it can be edited first.
    if (onPaste && list.length === 1 && !/\.zip$/i.test(list[0].file.name)) {
      const r = acceptBytes(list[0].path, new Uint8Array(await list[0].file.arrayBuffer()));
      if (r.file) { app.pasteText = r.file.text; app.pasteName = r.file.path; app.pasteLang = 'auto'; return; }
      if (r.skipped) { app.pendingSkipped = [...app.pendingSkipped, r.skipped]; return; }
    }
    await ingest(list);
  }

  function removePending(path: string) { app.pending = app.pending.filter((f) => f.path !== path); }

  async function load() {
    error = '';
    if (!draft.length) { error = 'Paste some code or add files first.'; return; }
    if (limits.level === 'stop') { error = limits.message; return; }
    resetTests();
    app.workspace = { files: draft, skipped: app.pendingSkipped, diff: app.diffText, spec: app.specText, loadedAt: Date.now() };
    await persist();
    app.notice = `Loaded ${limits.message} Open the Code tab to read it, or Tests to run its tests.`;
    void runAnalysis();
  }

  /** Replaces whatever is in the boxes with a bundled demo project and loads it (works offline). */
  async function tryDemo(id: DemoId) {
    const d = getDemo(id);
    app.pasteText = ''; app.pasteName = ''; app.pasteLang = 'auto'; app.testsText = '';
    app.pending = d.files; app.pendingSkipped = [];
    app.diffText = d.diff; app.specText = d.spec;
    await load();
    if (!error) app.notice = `Loaded the ${d.label} demo: ${d.files.length} files, with tests, a spec and a diff. Open Tests and press Run, then try the Queue.`;
  }

  const fmt = (n: number) => n.toLocaleString('en-US');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section aria-labelledby="input-h" class:dragging ondragenter={onDragEnter} ondragleave={onDragLeave} ondragover={onDragOver} ondrop={onDrop}>
  {#if dragging}<div class="drop-hint" aria-hidden="true">Drop files, a folder or a .zip anywhere. Drop one file on the paste box to edit it first.</div>{/if}
  <h1 id="input-h">Review some code</h1>
  <p class="callout blue">Everything stays on this device. Nothing is uploaded, and by default nothing is saved after you close this tab.</p>

  <div class="cols">
  <div class="col">
    <div class="card">
      <h2><label for="paste">Paste code</label></h2>
      <textarea id="paste" class="code" rows="10" spellcheck="false" autocapitalize="off" autocomplete="off"
        placeholder="Paste one file here, or drag a file onto this box" bind:value={app.pasteText}
      class:drop-target={dragging} class:drop-over={dragOverPaste}
      ondragenter={() => (dragOverPaste = true)} ondragleave={() => (dragOverPaste = false)}></textarea>
      <div class="grid2">
        <label>File name (optional)
          <input type="text" bind:value={app.pasteName} placeholder={pastedName(guess?.lang ?? 'python', 'code')} autocapitalize="off" spellcheck="false" />
        </label>
        <label>Language
          <select bind:value={app.pasteLang}>
            <option value="auto">Auto-detect</option>
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
          </select>
        </label>
      </div>
      {#if guess && app.pasteLang === 'auto'}
        <p class="muted small" data-testid="guess">
          Looks like <strong>{guess.lang === 'python' ? 'Python' : 'JavaScript'}</strong>
          <span class="tag">heuristic</span>{guess.confident ? '' : ' (not sure: set it by hand if wrong)'}
        </p>
      {/if}
    </div>

    <details class="card opt">
      <summary><h2>Optional: tests, diff, spec</h2></summary>
      <label for="tests">Tests (if not in the upload)</label>
      <textarea id="tests" class="code" rows="6" spellcheck="false" bind:value={app.testsText} placeholder="def test_…  or  test('…', () => …)"></textarea>
      <label for="diff">Git diff (unified format). Review will focus on the changed functions.</label>
      <textarea id="diff" class="code" rows="6" spellcheck="false" bind:value={app.diffText} placeholder="diff --git a/… b/…"></textarea>
      <label for="spec">Spec: what the code should do, one bullet per line</label>
      <textarea id="spec" rows="5" bind:value={app.specText} placeholder="- Users can reset their password&#10;- Totals round to cents"></textarea>
    </details>

  </div>
  <div class="col">
    <div class="card" data-testid="demo">
      <h2>New here? Try a demo</h2>
      <p class="muted small">A small shop project with deliberate problems, tests (one of them fails), a spec and a diff. It's built into the app, so it works offline. It replaces anything in the boxes.</p>
      <div class="demo-btns">
        <button class="btn" onclick={() => tryDemo('python')} data-testid="demo-python">Python demo</button>
        <button class="btn" onclick={() => tryDemo('javascript')} data-testid="demo-javascript">JavaScript demo</button>
      </div>
    </div>

    <div class="card">
      <h2>Upload files or a .zip</h2>
    <p class="muted small">Or drag files, a whole folder, or a .zip onto this page.</p>
      <label class="btn upload">
        {reading ? 'Reading…' : 'Choose files'}
        <input type="file" multiple accept=".py,.js,.mjs,.cjs,.jsx,.zip,application/zip" onchange={onFiles} class="sr-only" data-testid="file-input" />
      </label>
      {#if app.pending.length}
        <ul class="files" data-testid="pending">
          {#each app.pending as f (f.path)}
            <li>
              <span class="path">{f.path}</span>
              <span class="meta">{f.lang === 'python' ? 'Python' : 'JS'} · {fmt(f.lines)} lines{f.isTest ? ' · test' : ''}</span>
              <button class="btn small-btn" onclick={() => removePending(f.path)} aria-label={'Remove ' + f.path}>✕</button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if app.pendingSkipped.length}
        <details class="skipped" open>
          <summary>{app.pendingSkipped.length} file{app.pendingSkipped.length === 1 ? '' : 's'} not included</summary>
          <ul data-testid="skipped">
            {#each app.pendingSkipped as s (s.path + s.reason)}<li><span class="path">{s.path}</span> <span class="muted">{s.reason}</span></li>{/each}
          </ul>
        </details>
      {/if}
    </div>

    <div class="card">
      {#if draft.length}
        <p class="callout {limits.level === 'stop' ? 'stop' : limits.level === 'warn' ? 'warn' : 'sage'}" data-testid="limits" role={limits.level === 'stop' ? 'alert' : undefined}>
          {limits.message}
        </p>
      {/if}
      {#if error}<p class="callout stop" role="alert" data-testid="error">{error}</p>{/if}
      <button class="btn primary big" onclick={load} disabled={reading || limits.level === 'stop'}>Review this code</button>
    </div>

    {#if app.workspace}
      <div class="card" data-testid="loaded">
        <h2>Loaded</h2>
        <ul class="files">
          {#each app.workspace.files as f (f.path)}
            <li><span class="path">{f.path}</span>
              <span class="meta">{f.lang === 'python' ? 'Python' : 'JS'} ({f.langSource}) · {fmt(f.lines)} lines{f.isTest ? ' · test' : ''}</span></li>
          {/each}
        </ul>
        <p class="muted small">
          {app.workspace.files.filter((f) => f.isTest).length} test file(s) ·
          diff {app.workspace.diff.trim() ? 'supplied' : 'none'} ·
          spec {app.workspace.spec.trim() ? app.workspace.spec.split('\n').filter((l) => l.trim()).length + ' bullet(s)' : 'none'}
        </p>
      </div>
    {/if}

    <div class="card">
      <h2>Privacy on this device</h2>
      <label class="switch">
        <input type="checkbox" checked={app.settings.remember} onchange={(e) => setRemember((e.currentTarget as HTMLInputElement).checked)} data-testid="remember" />
        <span>Remember this session on this device</span>
      </label>
      <p class="muted small">Off by default. Turn it on only on your own phone or computer. While it's on, loaded code is saved in this browser (IndexedDB) until you press <strong>Clear everything</strong>. Only your theme and settings are always saved.</p>
    </div>
  </div>
  </div>
</section>

<style>
  /* Two columns on wide screens: what you paste on the left, files + actions on the right. */
  .cols { display: grid; gap: 0 20px; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 1100px) {
    .cols { grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); align-items: start; }
    #paste { min-height: 55vh; }
  }
  section.dragging .col > :global(.card:has([data-testid='file-input'])) { outline: 3px dashed var(--accent); outline-offset: 2px; }
  .drop-hint { position: sticky; top: 64px; z-index: 5; margin: 0 0 12px; padding: 12px 14px; border-radius: 12px; background: var(--accent); color: var(--accent-text); font-weight: 600; }
  textarea.drop-target { outline: 2px dashed var(--border); }
  textarea.drop-over { outline: 3px dashed var(--accent); }
  textarea { width: 100%; min-height: 44px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); resize: vertical; }
  input[type='text'], select { width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
  label { display: block; margin: 10px 0 4px; }
  .grid2 { display: grid; gap: 0 12px; grid-template-columns: 1fr; }
  @media (min-width: 560px) { .grid2 { grid-template-columns: 2fr 1fr; } }
  .small { font-size: 0.9rem; }
  .tag { font-size: 0.8rem; border: 1px dashed var(--muted); border-radius: 6px; padding: 0 6px; margin-left: 4px; }
  .demo-btns { display: flex; flex-wrap: wrap; gap: 10px; }
  .upload { display: inline-flex; align-items: center; margin: 0; }
  .files { list-style: none; padding: 0; margin: 12px 0 0; }
  .files li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 8px 0; border-top: 1px solid var(--border); }
  .path { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 16px; word-break: break-all; }
  .meta { color: var(--muted); font-size: 0.9rem; flex: 1; }
  .small-btn { min-height: 44px; padding: 4px 12px; }
  .skipped { margin-top: 12px; }
  .opt summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  .opt summary h2 { margin: 0; display: inline; }
  .big { width: 100%; font-size: 1.1rem; }
  .switch { display: flex; align-items: center; gap: 12px; min-height: 44px; }
  .switch input { width: 28px; height: 28px; accent-color: var(--accent); }
</style>
