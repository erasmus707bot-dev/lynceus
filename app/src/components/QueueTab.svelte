<script lang="ts">
  import { app, openFunction, runAnalysis } from '../lib/session.svelte';
  import { review, band } from '../lib/review.svelte';
  import RiskBreakdown from './RiskBreakdown.svelte';
  import WeightsPanel from './WeightsPanel.svelte';
  import type { FunctionRisk } from '../review/risk';

  const diffOn = $derived(!!review.diff?.supplied);
  const list = $derived(app.queueChangedOnly && diffOn ? review.risks.filter((r) => r.changed) : review.risks);
  const top = $derived(list.slice(0, 5));
  const rest = $derived(list.slice(5));
  const anyNoEvidence = $derived(review.risks.some((r) => r.noTestEvidence));
  function toggle(id: string) { app.openBreakdown = app.openBreakdown === id ? null : id; }
  $effect(() => { if (app.workspace && app.analysisStatus === 'idle') void runAnalysis(); });
</script>

{#snippet item(r: FunctionRisk, rank: number | null)}
  <li class="fn" data-testid="queue-item" data-fn={r.fn.qualname}>
    <div class="head">
      {#if rank}<span class="rank" aria-label={`Rank ${rank}`}>{rank}</span>{/if}
      <button class="score {band(r.score)}" aria-expanded={app.openBreakdown === r.id} onclick={() => toggle(r.id)} data-testid="score"
        aria-label={`Risk ${r.score} of 100, ${band(r.score)}. Show breakdown`}>
        <span class="n">{r.score}</span><span class="b">{band(r.score)}</span>
      </button>
      <div class="name">
        <button class="link" onclick={() => openFunction(r.path, r.fn.span.line, r.id)}>{r.fn.qualname}()</button>
        <span class="where">{r.path}:{r.fn.span.line}{r.noTestEvidence ? ' · no test evidence' : ''}{r.changed ? ' · changed' : ''}{review.scaffoldById.has(r.id) ? ' · possible scaffolding' : ''}</span>
      </div>
    </div>
    {#if app.openBreakdown === r.id}<RiskBreakdown risk={r} />{/if}
  </li>
{/snippet}

<section class="queue">
  <h1>Read these first</h1>
  {#if !app.workspace}
    <p class="muted">Nothing loaded yet. Load code on the Input tab first.</p>
  {:else if app.analysisStatus !== 'done'}
    <p class="callout blue" role="status">{app.analysisStatus === 'needs-consent' ? 'Python files need the one-time download first: open the Code tab.' : app.analysisMsg || 'Analyzing…'}</p>
  {:else if !review.risks.length}
    <p class="callout beige">No functions found in the loaded code, so there is nothing to rank.</p>
  {:else}
    <p class="small muted">The riskiest functions by a 0–100 score. Tap a score to see how it was worked out.{review.testPaths.size ? ' Functions in test files are left out.' : ''}</p>
    {#if anyNoEvidence}<p class="callout beige small" data-testid="no-evidence">No test evidence{review.coverage ? ' for some files' : ''}: the 20% coverage weight is shared out over the other factors. Run the tests on the Tests tab to include it.</p>{/if}
    {#if review.diff?.problems.length}
      <div class="callout warn small" data-testid="diff-problems">
        <strong>Diff problems</strong>
        <ul>{#each review.diff.problems as p, i (i)}<li><code>{p.file}</code>{p.hunk ? ` ${p.hunk}` : ''}: {p.reason}</li>{/each}</ul>
      </div>
    {/if}
    {#if diffOn}
      <label class="only"><input type="checkbox" bind:checked={app.queueChangedOnly} data-testid="changed-only"> Changed functions only ({review.risks.filter((r) => r.changed).length} of {review.risks.length})</label>
    {/if}
    {#if !list.length}<p class="callout beige">No functions are changed by the diff.</p>{/if}
    <ol class="list top">{#each top as r, i (r.id)}{@render item(r, i + 1)}{/each}</ol>
    {#if rest.length}
      <h2>All other functions</h2>
      <ul class="list">{#each rest as r (r.id)}{@render item(r, null)}{/each}</ul>
    {/if}
    <WeightsPanel />
  {/if}
</section>

<style>
  .small { font-size: 0.9rem; }
  .list { list-style: none; padding: 0; margin: 8px 0 16px; }
  .fn { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; margin-bottom: 8px; }
  .head { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .rank { font-weight: 700; color: var(--muted); width: 1.2em; text-align: right; flex: none; }
  .score { flex: none; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; min-width: 64px; min-height: 52px; border-radius: 10px; border: 2px solid var(--border); background: var(--surface); color: var(--text); padding: 2px 6px; cursor: pointer; }
  .score .n { font: 700 1.25rem/1.1 system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  .score .b { font-size: 0.75rem; }
  .score.high { border-color: var(--bad); color: var(--bad); }
  .score.medium { border-color: var(--r-unknown); color: var(--r-unknown); border-style: dashed; }
  .score.low { border-color: var(--ok); color: var(--ok); border-style: dotted; }
  .name { display: flex; flex-direction: column; min-width: 0; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; font: inherit; font-weight: 600; text-align: left; cursor: pointer; overflow-wrap: anywhere; min-height: 32px; }
  .where { color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
  .only { display: flex; align-items: center; gap: 8px; min-height: 44px; }
  .only input { width: 22px; height: 22px; }
  .callout ul { margin: 4px 0 0; padding-left: 1.2em; }
  .callout li { overflow-wrap: anywhere; }
</style>
