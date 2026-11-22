<script lang="ts">
  import { app, openFunction } from '../lib/session.svelte';
  import { review, band } from '../lib/review.svelte';
  import type { FunctionInfo } from '../analysis/model';

  // files → classes → functions, functions in source order
  const outline = $derived((app.analysis?.files ?? []).map((fa) => {
    const groups = new Map<string, FunctionInfo[]>();
    for (const fn of fa.functions) {
      const cls = fn.qualname.includes('.') ? fn.qualname.slice(0, fn.qualname.lastIndexOf('.')) : '';
      if (!groups.has(cls)) groups.set(cls, []);
      groups.get(cls)!.push(fn);
    }
    return { fa, groups: [...groups] };
  }));
  const sel = $derived(app.selectedFn ? review.graph.byId.get(app.selectedFn) ?? null : null);
  const callers = $derived(sel ? review.graph.callers.get(sel.fn.id) ?? [] : []);
  const callees = $derived(sel ? review.graph.callees.get(sel.fn.id) ?? [] : []);
  const KIND: Record<string, string> = { local: 'in your code', known: 'known (rule list)', unresolved: 'unresolved' };
</script>

<div class="shape">
  <div class="outline" role="tree" aria-label="Outline of files, classes and functions">
    {#each outline as { fa, groups } (fa.path)}
      <div class="file" role="treeitem" aria-expanded="true" aria-selected="false">
        <h2>{fa.path}{!fa.ok ? ' (syntax error)' : ''}</h2>
        {#if !fa.functions.length}<p class="small muted">No functions.</p>{/if}
        {#each groups as [cls, fns] (cls)}
          {#if cls}<h3 class="cls">class {cls}</h3>{/if}
          <ul class:indent={!!cls}>
            {#each fns as fn (fn.id)}
              {@const r = review.riskById.get(fn.id)}
              <li>
                <button class="fnrow" aria-pressed={app.selectedFn === fn.id} onclick={() => (app.selectedFn = app.selectedFn === fn.id ? null : fn.id)} data-testid="shape-fn">
                  {#if r}<span class="risk {band(r.score)}" title="Risk score">{r.score} <span class="b">{band(r.score)}</span></span>{/if}
                  <span class="nm">{fn.name}()</span>
                  <span class="ln">line {fn.span.line}</span>
                  {#if review.scaffoldById.has(fn.id)}<span class="tag">possible scaffolding</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/each}
      </div>
    {/each}
  </div>
  <aside class="graph card" aria-label="Call graph">
    {#if sel}
      <h2>{sel.fn.qualname}()</h2>
      <p class="small muted">{sel.path}:{sel.fn.span.line} · complexity {sel.fn.complexity ?? 1} · max depth {sel.fn.maxLevel}</p>
      {#if review.scaffoldById.has(sel.fn.id)}<p class="callout beige small"><strong>Possible scaffolding.</strong> {review.scaffoldById.get(sel.fn.id)!.reason}</p>{/if}
      <button class="btn" onclick={() => openFunction(sel.path, sel.fn.span.line, sel.fn.id)}>Read it in Lines</button>
      <h3>Called by ({callers.length})</h3>
      {#if !callers.length}<p class="small muted">Nothing in the loaded code calls it{sel.fn.name.startsWith('test') ? ' (test functions are called by the test runner)' : ''}.</p>{/if}
      <ul class="calls" data-testid="callers">
        {#each callers as c, i (i)}
          <li>{#if c.from}<button class="link" onclick={() => (app.selectedFn = c.from!.fn.id)}>{c.from.fn.qualname}()</button>{:else}module-level code{/if} <span class="muted small">{c.path}:{c.line}</span></li>
        {/each}
      </ul>
      <h3>Calls ({callees.length})</h3>
      {#if !callees.length}<p class="small muted">It calls nothing.</p>{/if}
      <ul class="calls" data-testid="callees">
        {#each callees as c, i (i)}
          <li class={c.kind}>
            {#if c.target && review.graph.byId.get(c.target)}<button class="link" onclick={() => (app.selectedFn = c.target)}>{c.name}()</button>{:else}<code>{c.name}()</code>{/if}
            <span class="kind {c.kind}">{KIND[c.kind]}</span> <span class="muted small">line {c.line}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">Tap a function to see what calls it and what it calls. Calls Lynceus can't resolve are marked <strong>unresolved</strong>.</p>
    {/if}
  </aside>
</div>

<style>
  .shape { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  @media (min-width: 1100px) { .shape { grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr); } .graph { position: sticky; top: 80px; align-self: start; } }
  .file h2 { font-size: 1.05rem; margin: 8px 0; overflow-wrap: anywhere; }
  .cls { font-size: 0.95rem; margin: 6px 0 4px; color: var(--muted); }
  ul { list-style: none; padding: 0; margin: 0 0 8px; }
  ul.indent { padding-left: 16px; border-left: 2px solid var(--border); }
  .fnrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; width: 100%; min-height: 44px; text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; margin-bottom: 6px; color: var(--text); font: inherit; cursor: pointer; }
  .fnrow[aria-pressed='true'] { outline: 3px solid var(--focus); outline-offset: -1px; }
  .nm { font-family: ui-monospace, monospace; font-weight: 600; overflow-wrap: anywhere; }
  .ln { color: var(--muted); font-size: 0.85rem; }
  .risk { font-weight: 700; font-variant-numeric: tabular-nums; border: 2px solid var(--border); border-radius: 8px; padding: 0 6px; min-width: 3.2em; text-align: center; }
  .risk .b { font-weight: 400; font-size: 0.75rem; }
  .risk.high { color: var(--bad); border-color: var(--bad); } .risk.medium { color: var(--r-unknown); border-color: var(--r-unknown); border-style: dashed; } .risk.low { color: var(--ok); border-color: var(--ok); border-style: dotted; }
  .tag { font-size: 0.8rem; border: 1px dashed var(--muted); border-radius: 6px; padding: 0 6px; }
  .graph h2 { font-size: 1.1rem; margin-top: 0; overflow-wrap: anywhere; }
  .graph h3 { font-size: 1rem; margin: 12px 0 4px; }
  .calls li { padding: 4px 0; border-bottom: 1px dashed var(--border); overflow-wrap: anywhere; }
  .kind { font-size: 0.8rem; border-radius: 6px; padding: 0 6px; border: 1px solid var(--border); }
  .kind.unresolved { border-style: dashed; color: var(--r-unknown); border-color: var(--r-unknown); }
  .kind.local { color: var(--ok); border-color: var(--ok); }
  .link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; font: inherit; cursor: pointer; text-align: left; min-height: 32px; font-family: ui-monospace, monospace; }
  .small { font-size: 0.9rem; }
</style>
