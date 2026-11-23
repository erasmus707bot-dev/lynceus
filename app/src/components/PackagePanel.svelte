<script lang="ts">
  // Package downloads (brief §5): off by default. Turning them on reopens the app on packages.html,
  // whose policy also allows pypi.org. Only package names are sent, and only after the reviewer confirms.
  import { app } from '../lib/session.svelte';
  import { fetchPackages, missingFromMessages, packagesMode, suggestDists, switchPackagesMode, PYPI, PYPI_FILES } from '../lib/packages';

  const on = packagesMode();
  const hasPy = $derived(!!app.workspace?.files.some((f) => f.lang === 'python'));
  const missing = $derived(app.testRun ? missingFromMessages(Object.values(app.testRun.results).map((r) => r.message)) : []);
  let names = $state('');
  let edited = $state(false);
  $effect(() => { if (!edited) names = suggestDists(missing).join(', '); });
  const list = $derived(names.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean));

  function toggle(e: Event) {
    const want = (e.currentTarget as HTMLInputElement).checked;
    switchPackagesMode(want, app.workspace ? $state.snapshot(app.workspace) : null);
  }

  async function download() {
    if (!list.length) return;
    app.packageStatus = 'fetching'; app.packageMsg = '';
    try {
      const r = await fetchPackages(list, fetch, (s) => (app.packageMsg = s));
      const have = new Set(app.extraWheels.map((w) => w.file));
      app.extraWheels = [...app.extraWheels, ...r.wheels.filter((w) => !have.has(w.file))];
      app.packageLog = r.log;
      app.packageMsg = r.wheels.length ? `Downloaded ${r.wheels.length} package${r.wheels.length === 1 ? '' : 's'}. Run the tests again to use ${r.wheels.length === 1 ? 'it' : 'them'}.` : 'Nothing was downloaded.';
    } finally { app.packageStatus = 'done'; }
  }
</script>

<details class="pkg card" open={on || (hasPy && missing.length > 0)} data-testid="packages">
  <summary>Package downloads: <strong>{on ? 'on' : 'off'}</strong></summary>
  <label class="switch">
    <input type="checkbox" checked={on} onchange={toggle} data-testid="packages-toggle" />
    <span>Allow downloading missing Python packages from PyPI</span>
  </label>
  {#if !on}
    <p class="small muted">Off: nothing leaves this device. Turning it on reopens Lynceus in a mode that may contact <code>{PYPI.replace('https://', '')}</code> and <code>{PYPI_FILES.replace('https://', '')}</code>. Only package <strong>names</strong> are sent, never your code, and only after you confirm them. Your loaded code comes with you. JavaScript has no package downloads.</p>
  {:else}
    <p class="small muted" data-testid="packages-on-note">On: this page may contact PyPI, but only when you press the button below. Your uploaded code still runs with the network blocked. Untick to go back to the fully offline page.</p>
    {#if hasPy}
      <label for="pkg-names" class="small">Package names to send to PyPI{missing.length ? ` (from the tests' missing imports: ${missing.join(', ')})` : ''}</label>
      <input id="pkg-names" type="text" bind:value={names} oninput={() => (edited = true)} placeholder="e.g. requests, PyYAML" autocapitalize="off" spellcheck="false" data-testid="packages-names" />
      <button class="btn primary" onclick={download} disabled={!list.length || app.packageStatus === 'fetching'} data-testid="packages-download">
        {app.packageStatus === 'fetching' ? 'Downloading…' : `Send ${list.length} name${list.length === 1 ? '' : 's'} to PyPI and download`}
      </button>
      {#if app.packageMsg}<p class="small" role="status" data-testid="packages-msg">{app.packageMsg}</p>{/if}
      {#if app.packageLog.length}
        <ul class="log" data-testid="packages-log">
          {#each app.packageLog as l (l.name)}
            <li class={l.status}><strong>{l.name}</strong>{l.version ? ` ${l.version}` : ''}: {l.status === 'installed' ? 'ready' : l.status === 'bundled' ? 'already included' : 'not installed'} <span class="muted">({l.detail})</span></li>
          {/each}
        </ul>
      {/if}
      {#if app.extraWheels.length}<p class="small muted">{app.extraWheels.length} downloaded package{app.extraWheels.length === 1 ? '' : 's'} kept in memory for this tab only.</p>{/if}
    {/if}
  {/if}
</details>

<style>
  .pkg { margin: 12px 0; }
  .pkg summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; gap: 6px; }
  .switch { display: flex; align-items: center; gap: 10px; min-height: 44px; }
  .switch input { width: 22px; height: 22px; }
  .small { font-size: 0.9rem; }
  input[type='text'] { width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); margin: 4px 0 10px; }
  .log { padding-left: 1.2em; margin: 10px 0 0; }
  .log li { margin-bottom: 4px; overflow-wrap: anywhere; }
  .log li.problem strong { color: var(--danger, #a33); }
</style>
