<script lang="ts">
  import { app, runTests, stopTestRun, setSettings } from '../lib/session.svelte';
  import { detectTests } from '../sandbox/detect-tests';
  import type { Outcome, TestResult } from '../sandbox/protocol';
  import PyodideConsent from './PyodideConsent.svelte';
  import PackagePanel from './PackagePanel.svelte';
  import { packagesMode } from '../lib/packages';

  const found = $derived(app.workspace ? detectTests(app.workspace.files) : []);
  const guessCount = $derived(found.reduce((n, f) => n + f.count, 0));
  const run = $derived(app.testRun);
  const p = $derived(app.testProgress);

  const ORDER: Outcome[] = ['failed', 'error', 'timeout', 'crashed', 'skipped', 'passed'];
  const LABEL: Record<Outcome, string> = { passed: 'passed', failed: 'failed', error: 'error', skipped: 'skipped', timeout: 'timed out', crashed: 'crashed' };
  const ICON: Record<Outcome, string> = { passed: '✓', failed: '✗', error: '!', skipped: '–', timeout: '⏱', crashed: '!' };

  const results = $derived(run ? run.tests.map((t) => run.results[t.id]).filter(Boolean) as TestResult[] : []);
  const counts = $derived.by(() => {
    const c: Partial<Record<Outcome, number>> = {};
    for (const r of results) c[r.outcome] = (c[r.outcome] ?? 0) + 1;
    return c;
  });
  const byFile = $derived.by(() => {
    const m = new Map<string, TestResult[]>();
    for (const r of results) { if (!m.has(r.file)) m.set(r.file, []); m.get(r.file)!.push(r); }
    return [...m];
  });
  const covFiles = $derived(run ? Object.entries(run.coverage).filter(([, c]) => c.statements.length).map(([path, c]) => {
    const hit = c.statements.filter((n) => (c.lines[n] ?? []).length).length;
    return { path, hit, total: c.statements.length };
  }) : []);

  function openCode(path: string) {
    if (!app.workspace?.files.some((f) => f.path === path)) return;
    app.codeFile = path; app.selectedLine = null; app.showCoverage = true; app.tab = 'code';
  }
  function setLimit(k: 'testTimeoutSec' | 'runTimeoutSec', v: string) {
    const n = Math.floor(Number(v));
    if (Number.isFinite(n) && n > 0 && n <= 3600) setSettings({ [k]: n });
  }
</script>

<section class="tests">
  <h1>Tests</h1>
  {#if !app.workspace}
    <p class="muted">Nothing loaded yet. Load code with its tests on the Input tab first.</p>
  {:else if !found.length}
    <div class="callout beige" role="status" data-testid="no-tests">
      <p><strong>No tests found</strong> in the loaded code, so there is nothing to run and the coverage layer is off.</p>
      <p class="small">Lynceus looks for pytest functions named <code>test_…</code> and JavaScript or TypeScript <code>test(…)</code> or <code>it(…)</code> calls. Paste tests into the Tests box on the Input tab, or upload test files.</p>
    </div>
  {:else if app.testStatus === 'needs-consent'}
    <PyodideConsent purpose="test" onaccept={() => runTests({ allowPython: true })} onskip={() => runTests({ allowPython: false })} />
  {:else}
    <div class="toolbar">
      {#if app.testStatus === 'running'}
        <button class="btn" onclick={stopTestRun}>Stop</button>
      {:else}
        <button class="btn primary" onclick={() => runTests()}>{run ? 'Run tests again' : 'Run tests'}</button>
      {/if}
      <p class="small found">Found about {guessCount} test{guessCount === 1 ? '' : 's'} in {found.length} file{found.length === 1 ? '' : 's'}.</p>
      <details class="limits">
        <summary>Time limits</summary>
        <label>Per test <input type="number" min="1" max="3600" value={app.settings.testTimeoutSec} onchange={(e) => setLimit('testTimeoutSec', e.currentTarget.value)} data-testid="test-timeout"> s</label>
        <label>Per run <input type="number" min="1" max="3600" value={app.settings.runTimeoutSec} onchange={(e) => setLimit('runTimeoutSec', e.currentTarget.value)}> s</label>
      </details>
    </div>
    <p class="small muted">Tests run in a sandbox on this device with the network blocked. {packagesMode() ? 'Package downloads are on (below).' : 'Package downloads are off, so only your files and the standard library are available.'}</p>
    <PackagePanel />

    {#if app.testStatus === 'running' && p}
      <div class="callout blue progress" role="status" aria-live="polite">
        <p>{p.status}{p.lang ? ` (${p.lang === 'python' ? 'Python' : 'JavaScript'})` : ''}</p>
        {#if p.total}
          <progress max={p.total} value={p.finished}></progress>
          <p class="small">{p.finished} of {p.total} done{p.current ? ` · running ${p.current.split('::').slice(1).join(' › ') || p.current}` : ''}</p>
        {/if}
      </div>
    {/if}

    {#if run}
      <div class="summary" data-testid="test-summary">
        {#each ORDER.filter((o) => counts[o]) as o (o)}
          <span class="pill {o}"><span aria-hidden="true">{ICON[o]}</span> {counts[o]} {LABEL[o]}</span>
        {/each}
        {#if !results.length}<span class="muted">No test results.</span>{/if}
      </div>
      {#if run.stopped}<p class="callout warn">You stopped the run. Tests that didn't run are listed below with that reason.</p>{/if}
      {#each run.notes as n, i (i)}<p class="callout warn small">{n}</p>{/each}

      {#each byFile as [file, rs] (file)}
        <div class="file card">
          <h2><button class="link" onclick={() => openCode(file)} title="Open in the Code tab">{file}</button></h2>
          <ul class="results">
            {#each rs as r (r.id)}
              <li class="res {r.outcome}" data-testid="result" data-outcome={r.outcome}>
                <div class="line">
                  <span class="pill {r.outcome}"><span aria-hidden="true">{ICON[r.outcome]}</span> {LABEL[r.outcome]}</span>
                  <span class="name">{r.name}</span>
                  {#if r.ms !== undefined && r.outcome !== 'skipped'}<span class="ms">{r.ms} ms</span>{/if}
                </div>
                {#if r.message}
                  <details open={r.outcome !== 'passed' && r.outcome !== 'skipped'}>
                    <summary>{r.outcome === 'skipped' ? 'Reason' : 'Details'}</summary>
                    <pre class="msg">{r.message}</pre>
                  </details>
                {/if}
                {#if r.output}
                  <details><summary>Output</summary><pre class="msg">{r.output}</pre></details>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}

      {#if covFiles.length}
        <div class="card cov">
          <h2>Coverage</h2>
          <p class="small muted">Statements run by at least one test or at import. Lines no test ran are dimmed in the Code tab and labelled "not run by the provided tests".</p>
          <ul>
            {#each covFiles as c (c.path)}
              <li><button class="link" onclick={() => openCode(c.path)}>{c.path}</button>: {c.hit} of {c.total} statements run</li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
  .found { margin: 0; }
  .small { font-size: 0.9rem; }
  .limits { margin-left: auto; }
  .limits summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  .limits label { display: inline-flex; align-items: center; gap: 6px; margin-right: 12px; }
  .limits input { width: 5em; min-height: 40px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); padding: 4px 8px; }
  .progress progress { width: 100%; height: 12px; accent-color: var(--accent); }
  .progress p { margin: 4px 0; overflow-wrap: anywhere; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  .pill { display: inline-flex; gap: 4px; align-items: center; border: 1.5px solid var(--border); border-radius: 999px; padding: 1px 10px; font-size: 0.9rem; white-space: nowrap; }
  .pill.passed { color: var(--ok); border-color: var(--ok); }
  .pill.failed, .pill.error, .pill.timeout, .pill.crashed { color: var(--bad); border-color: var(--bad); }
  .pill.skipped { color: var(--muted); border-style: dashed; }
  .file { margin-top: 12px; }
  .file h2, .cov h2 { font-size: 1.05rem; margin: 0 0 8px; overflow-wrap: anywhere; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; font: inherit; cursor: pointer; text-align: left; overflow-wrap: anywhere; min-height: 32px; }
  .results { list-style: none; padding: 0; margin: 0; }
  .res { border-top: 1px solid var(--border); padding: 8px 0; }
  .line { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
  .name { overflow-wrap: anywhere; min-width: 0; flex: 1 1 12em; }
  .ms { color: var(--muted); font-size: 0.85rem; }
  details summary { cursor: pointer; font-size: 0.9rem; color: var(--muted); min-height: 32px; display: flex; align-items: center; }
  .msg { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: 14px/1.5 ui-monospace, monospace; margin: 4px 0 0; max-height: 40vh; overflow: auto; }
  .cov ul { padding-left: 1.2em; margin: 0; }
</style>
