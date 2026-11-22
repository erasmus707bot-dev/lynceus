<script lang="ts">
  import { app } from '../lib/session.svelte';
  const PASSES = [
    { key: 'lines', label: 'Lines', hint: 'every line with its role' },
    { key: 'shape', label: 'Shape', hint: 'outline and call graph' },
    { key: 'flow', label: 'Flow', hint: 'only what the tests ran' },
    { key: 'intent', label: 'Intent', hint: 'spec bullets linked to code' },
  ] as const;
</script>

<div class="passes" role="tablist" aria-label="Reading pass">
  {#each PASSES as p (p.key)}
    <button role="tab" aria-selected={app.codePass === p.key} title={p.hint} onclick={() => { app.codePass = p.key; }} data-testid={`pass-${p.key}`}>{p.label}</button>
  {/each}
</div>

<style>
  .passes { display: inline-flex; border: 1.5px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 12px; max-width: 100%; flex-wrap: wrap; }
  button { min-height: 44px; padding: 6px 14px; border: 0; background: var(--surface); color: var(--text); font: inherit; cursor: pointer; border-right: 1px solid var(--border); }
  button:last-child { border-right: 0; }
  button[aria-selected='true'] { background: var(--accent); color: var(--accent-text); font-weight: 600; }
</style>
