<script lang="ts">
  import { app, type Tab } from '../lib/session.svelte';
  let { inline = false }: { inline?: boolean } = $props();
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'input', label: 'Input', icon: '⇪' },
    { id: 'queue', label: 'Queue', icon: '☰' },
    { id: 'code', label: 'Code', icon: '{ }' },
    { id: 'tests', label: 'Tests', icon: '✓' },
    { id: 'report', label: 'Report', icon: '▤' },
  ];
</script>

<nav class:inline class="tabbar" aria-label="Sections">
  {#each tabs as t (t.id)}
    <button class="tab" aria-current={app.tab === t.id ? 'page' : undefined} onclick={() => (app.tab = t.id)}>
      <span class="icon" aria-hidden="true">{t.icon}</span><span class="label">{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .tabbar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 10;
    display: grid; grid-template-columns: repeat(5, 1fr);
    background: var(--surface); border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom);
  }
  @media (min-width: 760px) { .tabbar:not(.inline) { display: none; } }
  .tabbar.inline { position: static; display: flex; gap: 4px; border: 0; padding: 0; background: none; }
  .tab {
    min-height: 56px; border: 0; background: none; color: var(--muted);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 0.85rem;
  }
  .inline .tab { min-height: 44px; flex-direction: row; gap: 6px; padding: 0 10px; font-size: 1rem; border-radius: 10px; }
  .tab[aria-current='page'] { color: var(--text); font-weight: 700; box-shadow: inset 0 3px 0 var(--gold); }
  .inline .tab[aria-current='page'] { box-shadow: inset 0 -3px 0 var(--gold); }
  .icon { font-size: 1.1rem; line-height: 1; }
</style>
