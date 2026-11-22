<script lang="ts">
  import { app, persist, setRemember } from '../lib/session.svelte';
  import { acceptBytes, makeFile, mergeFiles, pastedName, readZip } from '../lib/files';
  import { guessLang } from '../lib/detect';
  import { checkLimits } from '../lib/limits';
  import type { SourceFile } from '../lib/types';

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

  async function onFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const list = Array.from(input.files ?? []);
    if (!list.length) return;
    reading = true; error = '';
    try {
      const got: SourceFile[] = [];
      for (const f of list) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (/\.zip$/i.test(f.name)) {
          const z = readZip(bytes);
          got.push(...z.files); app.pendingSkipped = [...app.pendingSkipped, ...z.skipped];
        } else {
          const r = acceptBytes((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, bytes);
          if (r.file) got.push(r.file); if (r.skipped) app.pendingSkipped = [...app.pendingSkipped, r.skipped];
        }
      }
      app.pending = mergeFiles(app.pending, got);
    } catch (err) {
      error = 'Could not read those files: ' + (err as Error).message;
    } finally {
      reading = false;
      input.value = ''; // the browser's copy of the file list is released too
    }
  }

  function removePending(path: string) { app.pending = app.pending.filter((f) => f.path !== path); }

  async function load() {
    error = '';
    if (!draft.length) { error = 'Paste some code or add files first.'; return; }
    if (limits.level === 'stop') { error = limits.message; return; }
    app.workspace = { files: draft, skipped: app.pendingSkipped, diff: app.diffText, spec: app.specText, loadedAt: Date.now() };
    await persist();
    app.notice = `Loaded ${limits.message} Analysis views arrive in Phase 2.`;
  }

  const fmt = (n: number) => n.toLocaleString('en-US');
</script>

<section aria-labelledby="input-h">
  <h1 id="input-h">Review some code</h1>
  <p class="callout blue">Everything stays on this device. Nothing is uploaded, and by default nothing is saved after you close this tab.</p>

  <div class="card">
    <h2><label for="paste">Paste code</label></h2>
    <textarea id="paste" class="code" rows="10" spellcheck="false" autocapitalize="off" autocomplete="off"
      placeholder="Paste one file here" bind:value={app.pasteText}></textarea>
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

  <div class="card">
    <h2>Upload files or a .zip</h2>
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

  <details class="card opt">
    <summary><h2>Optional: tests, diff, spec</h2></summary>
    <label for="tests">Tests (if not in the upload)</label>
    <textarea id="tests" class="code" rows="6" spellcheck="false" bind:value={app.testsText} placeholder="def test_…  or  test('…', () => …)"></textarea>
    <label for="diff">Git diff (unified format). Review will focus on the changed functions.</label>
    <textarea id="diff" class="code" rows="6" spellcheck="false" bind:value={app.diffText} placeholder="diff --git a/… b/…"></textarea>
    <label for="spec">Spec: what the code should do, one bullet per line</label>
    <textarea id="spec" rows="5" bind:value={app.specText} placeholder="- Users can reset their password&#10;- Totals round to cents"></textarea>
  </details>

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
</section>

<style>
  textarea { width: 100%; min-height: 44px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); resize: vertical; }
  input[type='text'], select { width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
  label { display: block; margin: 10px 0 4px; }
  .grid2 { display: grid; gap: 0 12px; grid-template-columns: 1fr; }
  @media (min-width: 560px) { .grid2 { grid-template-columns: 2fr 1fr; } }
  .small { font-size: 0.9rem; }
  .tag { font-size: 0.8rem; border: 1px dashed var(--muted); border-radius: 6px; padding: 0 6px; margin-left: 4px; }
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
