<script lang="ts">
  import { FACTOR_LABEL, FACTOR_SCALE, type FunctionRisk } from '../review/risk';
  let { risk }: { risk: FunctionRisk } = $props();
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
</script>

<div class="breakdown" data-testid="breakdown">
  <p class="small muted">Score = sum of weight × value. Every value comes from the syntax tree, the test run or the diff.</p>
  <ul>
    {#each risk.factors as f (f.key)}
      <li class:off={!f.active}>
        <div class="row">
          <strong>{FACTOR_LABEL[f.key]}</strong>
          <span class="pts">{f.active ? `+${f.points}` : 'not used'}</span>
        </div>
        <div class="small">{f.raw}</div>
        {#if f.active}
          <div class="small muted">value {pct(f.value)} ({FACTOR_SCALE[f.key]}) × weight {f.weight}%{f.weight !== f.baseWeight ? ` (set to ${f.baseWeight}, scaled up because some factors have no evidence)` : ''}</div>
          <div class="bar" aria-hidden="true"><span style:width={`${f.value * 100}%`}></span></div>
        {:else}
          <div class="small muted">{f.note}</div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="total"><strong>Total: {risk.score} / 100</strong>{risk.noTestEvidence ? ' · no test evidence' : ''}</p>
</div>

<style>
  .breakdown { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 6px 0; border-bottom: 1px dashed var(--border); }
  li.off { opacity: 0.8; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .pts { font-variant-numeric: tabular-nums; font-weight: 600; }
  .small { font-size: 0.9rem; overflow-wrap: anywhere; }
  .bar { height: 6px; background: var(--border); border-radius: 3px; margin-top: 4px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); }
  .total { margin: 8px 0 0; }
</style>
