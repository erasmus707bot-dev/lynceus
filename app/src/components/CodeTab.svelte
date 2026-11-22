<script lang="ts">
  import { app, runAnalysis } from '../lib/session.svelte';
  import { ROLE_LETTER, ROLE_LABEL, ROLE_ORDER, type Role } from '../analysis/model';
  import CodeView from './CodeView.svelte';
  import EvidencePane from './EvidencePane.svelte';
  import PyodideConsent from './PyodideConsent.svelte';

  const fa = $derived(app.analysis?.files.find((f) => f.path === app.codeFile) ?? null);
  const src = $derived(app.workspace?.files.find((f) => f.path === app.codeFile) ?? null);
  const files = $derived(app.workspace?.files ?? []);
  const sheetOpen = $derived(app.selectedLine !== null || app.showHelp);

  function toggleRole(r: Role) {
    app.roleFilter = app.roleFilter.includes(r) ? app.roleFilter.filter((x) => x !== r) : [...app.roleFilter, r];
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { app.selectedLine = null; app.showHelp = false; }
  }
  const counts = $derived.by(() => {
    const c: Record<string, number> = {};
    for (const s of fa?.statements ?? []) c[s.role] = (c[s.role] ?? 0) + 1;
    return c;
  });
  $effect(() => { if (app.workspace && app.analysisStatus === 'idle') void runAnalysis(); });
</script>

<svelte:window onkeydown={onKey} />

{#if !app.workspace}
  <section class="card"><h1>Code</h1><p class="muted">Nothing loaded yet. Paste or upload code on the Input tab, then press <strong>Review this code</strong>.</p></section>
{:else if app.analysisStatus === 'needs-consent'}
  <PyodideConsent />
{:else if app.analysisStatus === 'running'}
  <p class="callout blue" role="status">{app.analysisMsg || 'Analyzing…'}</p>
{:else if app.analysisStatus === 'error'}
  <p class="callout stop" role="alert">Analysis failed: {app.analysisMsg}</p>
{:else}
  <div class="toolbar">
    <label class="file">File
      <select bind:value={app.codeFile} onchange={() => { app.selectedLine = null; }} data-testid="file-select">
        {#each files as f (f.path)}
          {@const a = app.analysis?.files.find((x) => x.path === f.path)}
          <option value={f.path}>{f.path}{f.isTest ? ' (test)' : ''}{!a ? ' — not analyzed' : !a.ok ? ' — syntax error' : ''}</option>
        {/each}
      </select>
    </label>
    <div class="chips" role="group" aria-label="Tint lines by role">
      {#each ROLE_ORDER as r (r)}
        <button class="chip r-{r}" aria-pressed={app.roleFilter.includes(r)} onclick={() => toggleRole(r)} title={ROLE_LABEL[r]}>
          <span class="l">{ROLE_LETTER[r]}</span> {ROLE_LABEL[r]} <span class="n">{counts[r] ?? 0}</span>
        </button>
      {/each}
    </div>
    <div class="right">
      <button class="btn" aria-pressed={app.wrap} onclick={() => (app.wrap = !app.wrap)}>{app.wrap ? 'Wrap: on' : 'Wrap: off'}</button>
      <button class="btn help-btn" onclick={() => { app.selectedLine = null; app.showHelp = !app.showHelp; }}>How to read this</button>
    </div>
  </div>
  {#if app.pythonSkipped}<p class="callout warn">Python files were skipped (Python support not downloaded). <button class="btn" onclick={() => { app.analysisStatus = 'needs-consent'; }}>Download now</button></p>{/if}
  {#if fa && !fa.ok}
    <p class="callout stop" role="alert">Couldn't parse {fa.path}: {fa.error?.message} (line {fa.error?.line}). The code is shown without markers.</p>
  {/if}
  {#if src && !fa}<p class="callout warn">{src.path} was not analyzed.</p>{/if}
  <div class="split">
    <div class="left">{#if src}<CodeView text={src.text} {fa} />{/if}</div>
    <div class="right-pane"><div class="sticky"><EvidencePane {fa} /></div></div>
  </div>
  {#if sheetOpen}
    <div class="sheet" role="dialog" aria-label="Line details">
      <EvidencePane {fa} onclose={() => { app.selectedLine = null; app.showHelp = false; }} />
    </div>
  {/if}
{/if}

<style>
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: end; margin-bottom: 12px; }
  .file { display: flex; flex-direction: column; font-size: 0.9rem; min-width: 0; max-width: 100%; }
  .file select { min-height: 44px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 6px 10px; max-width: 100%; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { min-height: 44px; border: 1.5px solid var(--border); background: var(--surface); border-radius: 999px; padding: 4px 12px; font-size: 0.9rem; display: inline-flex; align-items: center; gap: 6px; }
  .chip .l { font: 700 15px ui-monospace, monospace; }
  .chip .n { color: var(--muted); font-size: 0.85em; }
  .chip[aria-pressed='true'] { border-color: currentColor; font-weight: 600; }
  .chip.r-io .l, .chip.r-io[aria-pressed='true'] { color: var(--r-io); } .chip.r-io[aria-pressed='true'] { background: var(--r-io-bg); }
  .chip.r-mutation .l, .chip.r-mutation[aria-pressed='true'] { color: var(--r-mutation); } .chip.r-mutation[aria-pressed='true'] { background: var(--r-mutation-bg); }
  .chip.r-control .l, .chip.r-control[aria-pressed='true'] { color: var(--r-control); } .chip.r-control[aria-pressed='true'] { background: var(--r-control-bg); }
  .chip.r-pure .l, .chip.r-pure[aria-pressed='true'] { color: var(--r-pure); } .chip.r-pure[aria-pressed='true'] { background: var(--r-pure-bg); }
  .chip.r-unknown .l, .chip.r-unknown[aria-pressed='true'] { color: var(--r-unknown); } .chip.r-unknown[aria-pressed='true'] { background: var(--r-unknown-bg); }
  .right { display: flex; gap: 8px; margin-left: auto; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .right-pane { display: none; }
  .sheet {
    position: fixed; left: 0; right: 0; bottom: calc(57px + env(safe-area-inset-bottom)); z-index: 20;
    max-height: 60vh; overflow: auto; background: var(--surface); border-top: 2px solid var(--gold);
    padding: 16px; box-shadow: 0 -8px 24px rgb(0 0 0 / 0.25);
  }
  @media (min-width: 760px) { .sheet { bottom: 0; } }
  @media (min-width: 1100px) {
    .split { grid-template-columns: minmax(0, 1.7fr) minmax(320px, 1fr); }
    .right-pane { display: block; }
    .sticky { position: sticky; top: 80px; max-height: calc(100vh - 100px); overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
    .sheet { display: none; }
    .help-btn { display: none; }
  }
</style>
