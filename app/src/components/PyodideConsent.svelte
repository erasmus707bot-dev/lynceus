<script lang="ts">
  import { app, doAnalyze } from '../lib/session.svelte';
  import { PYODIDE_BYTES } from '../analysis/client';
  const mb = (PYODIDE_BYTES / 1e6).toFixed(1);
  const pyCount = $derived(app.workspace?.files.filter((f) => f.lang === 'python').length ?? 0);
</script>

<div class="callout beige consent" role="region" aria-label="Python support download">
  <h2>Python needs a one-time download</h2>
  <p>To read {pyCount} Python file{pyCount === 1 ? '' : 's'}, Lynceus loads its own copy of Python (Pyodide) from this website: <strong>{mb} MB</strong>, less if the server compresses it.</p>
  <ul>
    <li><strong>Your code is not sent anywhere.</strong> This only downloads Lynceus's own files.</li>
    <li>After this, Python reviews work offline on this device.</li>
  </ul>
  <div class="actions">
    <button class="btn primary" onclick={() => doAnalyze(true)}>Download Python support</button>
    <button class="btn" onclick={() => doAnalyze(false)}>Skip Python files for now</button>
  </div>
</div>

<style>
  .consent h2 { margin-top: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
</style>
