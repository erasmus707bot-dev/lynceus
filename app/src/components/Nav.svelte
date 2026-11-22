<script lang="ts">
  import { app, setSettings, clearEverything } from '../lib/session.svelte';
  import TabBar from './TabBar.svelte';
  const dark = $derived(app.settings.theme === 'dark');
</script>

<header class="nav">
  <div class="row">
    <span class="brand">Lynceus</span>
    {#if app.settings.remember}
      <span class="pill" role="status" title="Your session is being saved on this device">● Remembering</span>
    {/if}
    <div class="grow"></div>
    <div class="wide-tabs"><TabBar inline /></div>
    <button class="btn" aria-pressed={dark} onclick={() => setSettings({ theme: dark ? 'light' : 'dark' })}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? '☀ Light' : '☾ Dark'}
    </button>
    <button class="btn danger" onclick={clearEverything}>Clear everything</button>
  </div>
</header>

<style>
  .nav { position: sticky; top: 0; z-index: 10; background: var(--surface); border-bottom: 1px solid var(--border); }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; max-width: 1100px; margin: 0 auto; padding: 8px 16px; }
  .brand { font-weight: 700; font-size: 1.2rem; color: var(--gold); letter-spacing: 0.02em; }
  .pill { font-size: 0.85rem; padding: 2px 10px; border-radius: 999px; background: var(--warn-bg); border: 1px solid var(--border); }
  .grow { flex: 1; }
  .wide-tabs { display: none; }
  @media (min-width: 760px) { .wide-tabs { display: block; } }
</style>
