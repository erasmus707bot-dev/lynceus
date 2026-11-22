<script lang="ts">
  import { app, setSettings } from '../lib/session.svelte';
  import { DEFAULT_WEIGHTS, FACTOR_LABEL, FACTOR_ORDER, type FactorKey } from '../review/risk';
  const total = $derived(FACTOR_ORDER.reduce((n, k) => n + app.settings.riskWeights[k], 0));
  function set(k: FactorKey, v: string) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return;
    setSettings({ riskWeights: { ...app.settings.riskWeights, [k]: n } });
  }
</script>

<details class="weights card">
  <summary>Risk weights</summary>
  <p class="small muted">Defaults from the brief: 30 / 20 / 20 / 20 / 10. Weights are scaled so the factors that have evidence add up to 100. Saved on this device.</p>
  <div class="grid">
    {#each FACTOR_ORDER as k (k)}
      <label>{FACTOR_LABEL[k]} <input type="number" min="0" max="1000" value={app.settings.riskWeights[k]} onchange={(e) => set(k, e.currentTarget.value)} data-testid={`weight-${k}`}></label>
    {/each}
  </div>
  <p class="small">Total as set: {total}{total !== 100 ? ' (it will be scaled to 100)' : ''}</p>
  <button class="btn" onclick={() => setSettings({ riskWeights: { ...DEFAULT_WEIGHTS } })}>Reset to defaults</button>
</details>

<style>
  .weights summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 16px; margin: 8px 0; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  input { width: 5.5em; min-height: 40px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); padding: 4px 8px; }
  .small { font-size: 0.9rem; }
</style>
