<script lang="ts">
  import { app, runAnalysis, openFunction } from '../lib/session.svelte';
  import { review } from '../lib/review.svelte';
  import { buildReport, toMarkdown } from '../report/report';

  const model = $derived(app.workspace && app.analysisStatus === 'done' ? buildReport({
    workspace: app.workspace, analysis: app.analysis, testRun: app.testRun, risks: review.risks, checks: review.checks,
    reviews: review.reviews, progress: review.progress, spec: review.spec, links: review.links, testPaths: review.testPaths,
    excerpts: app.reportExcerpts, generatedAt: new Date(),
  }) : null);
  const OUT = ['passed', 'failed', 'error', 'timeout', 'crashed', 'skipped'] as const;
  $effect(() => { if (app.workspace && app.analysisStatus === 'idle') void runAnalysis(); });

  function download() {
    if (!model) return;
    const blob = new Blob([toMarkdown(model)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lynceus-report-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
</script>

<section class="report">
  <h1>Report</h1>
  {#if !app.workspace}
    <p class="muted">Nothing loaded yet. Load code on the Input tab first.</p>
  {:else if !model}
    <p class="callout blue" role="status">{app.analysisStatus === 'needs-consent' ? 'Python files need the one-time download first: open the Code tab.' : app.analysisMsg || 'Analyzing…'}</p>
  {:else}
    <div class="actions no-print">
      <label class="chk"><input type="checkbox" bind:checked={app.reportExcerpts} data-testid="excerpts"> Include code excerpts</label>
      <button class="btn primary" onclick={download} data-testid="download-md">Download Markdown</button>
      <button class="btn" onclick={() => window.print()} data-testid="print">Print / Save as PDF</button>
    </div>
    <p class="small muted no-print">The report has no source code unless you tick <strong>Include code excerpts</strong>. Possible secrets are always masked. To make a PDF, choose <strong>Save as PDF</strong> in the print dialog.</p>

    <article class="sheet-doc" data-testid="report">
      <p class="small muted">Generated {model.generated} on this device. No code left the device. {model.excerpts ? 'Code excerpts included (secrets masked).' : 'No source code in this report.'}</p>

      <h2>Summary</h2>
      <ul class="facts">
        <li><strong>Reviewed:</strong> <span data-testid="report-progress">{model.progress.pct}%</span> of {model.progress.weighted ? 'risk-weighted code' : 'functions'} ({model.progress.done} of {model.progress.total} functions)</li>
        <li><strong>Findings:</strong> {model.findingCount}</li>
        <li><strong>Tests:</strong> {model.tests.ran ? OUT.filter((k) => model.tests.counts[k]).map((k) => `${model.tests.counts[k]} ${k}`).join(', ') || 'no results' : 'not run'}</li>
        <li><strong>Files:</strong> {model.files.length}{model.diff ? ', with a diff' : ''}</li>
      </ul>

      <h2>Unreviewed high-risk functions</h2>
      <p class="small muted">The reading queue's top 5 (score above 0) plus any rated high, not yet marked reviewed.</p>
      {#if !model.unreviewed.length}<p>None: every function in the top 5 (score above 0) or rated high is marked reviewed.</p>{/if}
      <ul class="items" data-testid="report-unreviewed">
        {#each model.unreviewed as u (u.path + u.line)}
          <li><button class="link" onclick={() => openFunction(u.path, u.line)}><code>{u.name}()</code></button> <span class="muted">{u.path}:{u.line}</span> · risk <strong>{u.score}</strong> ({u.band}){u.findings ? ` · ${u.findings} finding${u.findings === 1 ? '' : 's'}` : ''}
            {#if u.excerpt}<pre class="ex">{#each u.excerpt.lines as l, i (i)}{String(u.excerpt.first + i).padStart(4)}  {l}{'\n'}{/each}</pre>{/if}</li>
        {/each}
      </ul>

      <h2>Findings</h2>
      {#if !model.findings.length}<p>No findings.</p>{/if}
      {#each model.findings as g (g.check)}
        <h3>{g.label} ({g.items.length})</h3>
        <ul class="items" data-testid={`report-${g.check}`}>
          {#each g.items as f, i (i)}
            <li>
              <button class="link" onclick={() => openFunction(f.path, f.line)}>{f.path}:{f.line}{f.endLine !== f.line ? `–${f.endLine}` : ''}</button>: {f.detail}
              <div class="meta"><span class="tag {f.certainty}">{f.certainty}</span> rule <code>{f.rule}</code> · evidence: {f.source}</div>
              {#if f.excerpt}<pre class="ex">{#each f.excerpt.lines as l, j (j)}{String(f.excerpt.first + j).padStart(4)}  {l}{'\n'}{/each}</pre>{/if}
            </li>
          {/each}
        </ul>
      {/each}

      <h2>Test results</h2>
      {#if !model.tests.ran}<p>Tests were not run, so there is no test evidence in this review.</p>
      {:else}
        <p>{OUT.filter((k) => model.tests.counts[k]).map((k) => `${model.tests.counts[k]} ${k}`).join(', ') || 'No results.'}</p>
        <ul class="items">
          {#each model.tests.notable as t, i (i)}
            <li><strong>{t.outcome}</strong>: {t.name} <span class="muted">({t.file})</span>{#if t.message}<pre class="ex">{t.message}</pre>{/if}</li>
          {/each}
        </ul>
        {#if model.tests.notable.length && !model.excerpts}<p class="small muted">Failure messages are left out because they can quote code. Tick "Include code excerpts" to add them.</p>{/if}
      {/if}

      <h2>Lines not run by the provided tests</h2>
      {#if !model.untested}<p>No coverage: tests were not run.</p>
      {:else if !model.untested.length}<p>Every statement was run by at least one test or at import.</p>
      {:else}<ul class="items">{#each model.untested as u (u.path)}<li>{u.path}: {u.count} statement line{u.count === 1 ? '' : 's'} (lines {u.lines})</li>{/each}</ul>{/if}

      {#if model.notes.length}
        <h2>Review notes</h2>
        <ul class="items">{#each model.notes as n (n.path + n.line)}<li>{n.done ? '✓' : '○'} <code>{n.name}()</code> <span class="muted">({n.path}:{n.line})</span>{n.note ? `: ${n.note}` : ''}</li>{/each}</ul>
      {/if}
      {#if model.spec.length}
        <h2>Spec coverage</h2>
        <ul class="items">{#each model.spec as s, i (i)}<li>{s.text}: {s.linked.length ? s.linked.join('; ') : 'not linked'}</li>{/each}</ul>
      {/if}
      <h2>Files</h2>
      <ul class="items">{#each model.files as f (f.path)}<li>{f.path} ({f.lang}, {f.lines} lines{f.isTest ? ', tests' : ''})</li>{/each}</ul>
      <p class="small muted">Every finding comes from the syntax tree, the test run or the diff. Lynceus uses no AI.</p>
    </article>
  {/if}
</section>

<style>
  .actions { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
  .chk { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; }
  .chk input { width: 22px; height: 22px; }
  .small { font-size: 0.9rem; }
  .sheet-doc { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-top: 12px; }
  h2 { font-size: 1.15rem; margin: 1.2em 0 0.4em; }
  h3 { font-size: 1rem; margin: 1em 0 0.3em; }
  .facts, .items { padding-left: 1.2em; margin: 0; }
  .items li, .facts li { margin-bottom: 6px; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .tag { font-size: 0.75rem; border-radius: 6px; padding: 0 6px; border: 1.5px solid var(--muted); }
  .tag.heuristic { border-style: dashed; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; font: inherit; cursor: pointer; text-align: left; overflow-wrap: anywhere; min-height: 32px; }
  .ex { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font: 14px/1.5 ui-monospace, monospace; margin: 4px 0 0; }
  @media print {
    .sheet-doc { border: 0; padding: 0; background: none; }
    .link { color: inherit; text-decoration: none; }
    h2 { break-after: avoid; }
    li { break-inside: avoid; }
  }
</style>
