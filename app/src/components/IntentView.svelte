<script lang="ts">
  import { app, toggleSpecLink, openFunction } from '../lib/session.svelte';
  import { review } from '../lib/review.svelte';

  const item = $derived(review.spec.find((s) => s.id === app.specItem) ?? null);
  const linksFor = (id: string) => review.links.filter((l) => l.item === id);
  const isLinked = (kind: 'function' | 'test', ref: string) => !!item && review.links.some((l) => l.item === item.id && l.kind === kind && l.ref === ref);
  const sugg = $derived(item ? review.suggestions.filter((s) => s.item === item.id) : []);
  const labelOf = (kind: 'function' | 'test', ref: string) => review.targets.find((t) => t.kind === kind && t.ref === ref)?.label ?? ref;
  const fns = $derived(review.targets.filter((t) => t.kind === 'function'));
  const tests = $derived(review.targets.filter((t) => t.kind === 'test'));
</script>

<div class="intent">
  {#if !review.spec.length}
    <div class="callout beige">
      <p><strong>No spec to link.</strong> Paste the spec or requirements (one bullet per line) into the Spec box on the Input tab, then load again.</p>
    </div>
  {:else}
    <div class="cols">
      <div>
        <h2>Spec</h2>
        <p class="small muted">Tap a bullet, then tap the functions or tests it covers. Only links you make or confirm count.</p>
        <ul class="items">
          {#each review.spec as s (s.id)}
            {@const n = linksFor(s.id).length}
            <li><button class="item" aria-pressed={app.specItem === s.id} onclick={() => (app.specItem = app.specItem === s.id ? null : s.id)} data-testid="spec-item">
              <span>{s.text}</span><span class="count">{n ? `${n} linked` : 'not linked'}</span>
            </button></li>
          {/each}
        </ul>
      </div>
      <div>
        {#if item}
          <h2>Linked to “{item.text}”</h2>
          {#if !linksFor(item.id).length}<p class="small muted">Nothing linked yet.</p>{/if}
          <ul class="linked" data-testid="linked">
            {#each linksFor(item.id) as l (l.kind + l.ref)}
              <li><span class="k">{l.kind}</span> {labelOf(l.kind, l.ref)} <span class="muted small">({l.how})</span>
                <button class="btn sm" onclick={() => toggleSpecLink(l.item, l.kind, l.ref)} aria-label={`Remove link to ${labelOf(l.kind, l.ref)}`}>Remove</button></li>
            {/each}
          </ul>
          {#if sugg.length}
            <h3>Suggestions <span class="tag heuristic">heuristic</span></h3>
            <p class="small muted">Shared words only. They don't count until you confirm them.</p>
            <ul class="linked" data-testid="suggestions">
              {#each sugg as s (s.kind + s.ref)}
                <li><span class="k">{s.kind}</span> {s.label} <span class="muted small">shares “{s.shared.join('”, “')}”</span>
                  <button class="btn sm" onclick={() => toggleSpecLink(s.item, s.kind, s.ref, 'confirmed suggestion')}>Confirm</button></li>
              {/each}
            </ul>
          {/if}
          <h3>Link by hand</h3>
          <div class="pick" data-testid="pick-functions">
            {#each fns as t (t.ref)}<button class="chip" aria-pressed={isLinked('function', t.ref)} onclick={() => toggleSpecLink(item.id, 'function', t.ref)}>{t.label}()</button>{/each}
          </div>
          {#if tests.length}
            <div class="pick">{#each tests as t (t.ref)}<button class="chip test" aria-pressed={isLinked('test', t.ref)} onclick={() => toggleSpecLink(item.id, 'test', t.ref)}>test: {t.label}</button>{/each}</div>
          {:else}<p class="small muted">Run the tests to link tests too.</p>{/if}
        {:else}
          <p class="muted">Pick a spec bullet to link it.</p>
        {/if}
      </div>
    </div>
  {/if}

  <div class="card scaff" data-testid="scaffolding">
    <h2>Possible scaffolding</h2>
    {#if !review.coverage}
      <p class="small muted">Run the tests first. Without test evidence Lynceus can't tell which code no test reaches, so nothing is flagged.</p>
    {:else if !review.scaffold.length}
      <p class="small">Nothing flagged: every function was reached by a test or is linked to a spec bullet.</p>
    {:else}
      <ul>
        {#each review.scaffold as f (f.id)}
          {@const r = review.riskById.get(f.id)}
          {#if r}<li><button class="link" onclick={() => openFunction(r.path, r.fn.span.line, r.id)}>{r.fn.qualname}()</button> <span class="muted small">{r.path}:{r.fn.span.line}</span><br><span class="small">{f.reason}</span></li>{/if}
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  @media (min-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
  h2 { font-size: 1.1rem; margin: 4px 0 8px; overflow-wrap: anywhere; }
  h3 { font-size: 1rem; margin: 12px 0 4px; }
  .small { font-size: 0.9rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  .item { display: flex; justify-content: space-between; gap: 10px; width: 100%; min-height: 44px; text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-bottom: 6px; color: var(--text); font: inherit; cursor: pointer; }
  .item[aria-pressed='true'] { outline: 3px solid var(--focus); outline-offset: -1px; }
  .item span:first-child { overflow-wrap: anywhere; min-width: 0; }
  .count { color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
  .linked li { padding: 6px 0; border-bottom: 1px dashed var(--border); overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .k { font-size: 0.75rem; border: 1px solid var(--border); border-radius: 6px; padding: 0 6px; }
  .tag { font-size: 0.8rem; border-radius: 6px; padding: 1px 8px; border: 1.5px dashed var(--muted); font-weight: 400; }
  .btn.sm { min-height: 36px; padding: 2px 10px; font-size: 0.9rem; }
  .pick { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .chip { min-height: 44px; border: 1.5px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 4px 12px; font: 0.9rem ui-monospace, monospace; cursor: pointer; overflow-wrap: anywhere; text-align: left; max-width: 100%; }
  .chip[aria-pressed='true'] { border-color: var(--accent); background: var(--callout-blue); font-weight: 700; }
  .chip[aria-pressed='true']::before { content: '✓ '; }
  .scaff { margin-top: 16px; }
  .scaff li { padding: 6px 0; border-bottom: 1px dashed var(--border); overflow-wrap: anywhere; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; font: inherit; cursor: pointer; min-height: 32px; font-family: ui-monospace, monospace; }
</style>
