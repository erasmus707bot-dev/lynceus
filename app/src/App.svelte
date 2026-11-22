<script lang="ts">
  import Nav from './components/Nav.svelte';
  import TabBar from './components/TabBar.svelte';
  import InputScreen from './components/InputScreen.svelte';
  import Placeholder from './components/Placeholder.svelte';
  import CodeTab from './components/CodeTab.svelte';
  import TestsTab from './components/TestsTab.svelte';
  import { app } from './lib/session.svelte';
</script>

<Nav />
<main id="main" tabindex="-1">
  {#if app.notice}
    <div class="callout sage notice" role="status">
      <span>{app.notice}</span>
      <button class="btn" onclick={() => (app.notice = '')} aria-label="Dismiss message">✕</button>
    </div>
  {/if}
  {#if app.tab === 'input'}
    <InputScreen />
  {:else if app.tab === 'queue'}
    <Placeholder title="Reading queue" phase={4} what="the “Read these first” list of the riskiest functions, with score breakdowns." />
  {:else if app.tab === 'code'}
    <CodeTab />
  {:else if app.tab === 'tests'}
    <TestsTab />
  {:else}
    <Placeholder title="Report" phase={5} what="review progress and Markdown/PDF export." />
  {/if}
</main>
<TabBar />

<style>
  main { margin: 0 auto; padding: 16px 16px calc(96px + env(safe-area-inset-bottom)); }
  @media (min-width: 1100px) { main { padding-left: 32px; padding-right: 32px; } }
  @media (min-width: 760px) { main { padding-bottom: 32px; } }
  .notice { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
</style>
