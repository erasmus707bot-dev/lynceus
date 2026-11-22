<script lang="ts">
  import { app } from '../lib/session.svelte';
  import { ROLE_LETTER, ROLE_LABEL, type FileAnalysis } from '../analysis/model';
  import HowToRead from './HowToRead.svelte';
  import { lineCoverage, MISS_LABEL } from '../sandbox/coverage';

  let { fa, onclose }: { fa: FileAnalysis | null; onclose?: () => void } = $props();

  const line = $derived(app.selectedLine);
  const stmts = $derived(fa && line ? fa.statements.filter((s) => s.span.line <= line && line <= Math.max(s.span.line, Math.min(s.headerEnd, s.span.endLine))) : []);
  const blocks = $derived(fa && line ? fa.blocks.filter((b) => b.span.line === line) : []);
  const fnOf = (id: string | null) => (id && fa ? fa.functions.find((f) => f.id === id) : null);
  const enclosing = $derived(fa && line ? fa.blocks.filter((b) => b.headerEnd < line && line <= b.span.endLine && b.kind !== 'function' && b.kind !== 'class') : []);
  const lc = $derived(line && app.codeFile ? lineCoverage(app.testRun?.coverage[app.codeFile], line) : null);
  const testName = (id: string) => app.testRun?.results[id]?.name ?? app.testRun?.tests.find((t) => t.id === id)?.name ?? id;
  const outcomeOf = (id: string) => app.testRun?.results[id]?.outcome ?? '';
  const level = $derived(enclosing.length ? Math.max(...enclosing.map((b) => b.level)) : 0);
</script>

<aside class="pane" aria-label="Evidence">
  {#if onclose}<button class="btn close" onclick={onclose} aria-label="Close panel">✕</button>{/if}
  {#if line && (fa || lc)}
    <h2>Line {line}</h2>
    {#if lc}
      <div class="stmt cov" data-testid="line-tests">
        <h3>Tests</h3>
        {#if lc.state === 'run'}
          <p class="small">Run by {lc.tests.length} test{lc.tests.length === 1 ? '' : 's'} <span class="tag certain">certain</span> <span class="meta">from the test run</span></p>
          <ul class="tests">{#each lc.tests as t (t)}<li><span class="oc {outcomeOf(t)}">{outcomeOf(t)}</span> {testName(t)}</li>{/each}</ul>
        {:else if lc.state === 'import'}
          <p class="small">Run only when the file was imported, not inside any test <span class="tag certain">certain</span></p>
        {:else}
          <p class="small"><strong>{MISS_LABEL[0].toUpperCase() + MISS_LABEL.slice(1)}.</strong> This doesn't mean the line is dead, only that none of the tests you gave reached it. <span class="tag certain">certain</span></p>
        {/if}
      </div>
    {/if}
    {#if fa && !stmts.length && !blocks.length}
      <p class="muted">No statement starts or runs on this line (blank, comment, or the inside of a longer expression).</p>
    {/if}
    {#each stmts as s (s.id)}
      <div class="stmt">
        <p class="head">
          <span class="badge r-{s.role}" class:dashed={s.certainty === 'heuristic'}>{ROLE_LETTER[s.role]}</span>
          <strong>{ROLE_LABEL[s.role]}</strong>
          <span class="tag {s.certainty}">{s.certainty}</span>
        </p>
        <p class="muted small">{s.kind}, lines {s.span.line}–{s.span.endLine}{fnOf(s.fn) ? ` · inside ${fnOf(s.fn)!.qualname}()` : ' · module level'}</p>
        <h3>Evidence</h3>
        <ul class="evidence">
          {#each s.evidence as e, i (i)}
            <li>
              <span class="badge sm r-{e.role}" class:dashed={e.certainty === 'heuristic'}>{ROLE_LETTER[e.role]}</span>
              <span>{e.detail}</span>
              <span class="meta">rule <code>{e.rule}</code> · {e.certainty} · from the {e.source}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
    {#each blocks as b (b.id)}
      <div class="stmt">
        <h3>Block: {b.label}</h3>
        <p>{b.summary}</p>
        {#if b.kind !== 'function' && b.kind !== 'class'}
          <p class="small" class:warn={b.level > app.settings.nestingLimit}>Nesting level {b.level}{b.level > app.settings.nestingLimit ? ` — deeper than the limit of ${app.settings.nestingLimit}` : ''}.</p>
        {/if}
      </div>
    {/each}
    {#if level}<p class="muted small">This line sits {level} level{level === 1 ? '' : 's'} deep inside its function.</p>{/if}
  {:else}
    <HowToRead />
  {/if}
</aside>

<style>
  .pane { position: relative; }
  .close { position: absolute; top: 0; right: 0; }
  h2 { margin-top: 0; }
  h3 { font-size: 1rem; margin: 0.8em 0 0.3em; }
  .stmt { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px; }
  .head { display: flex; align-items: center; gap: 8px; margin: 0; flex-wrap: wrap; }
  .small { font-size: 0.9rem; }
  .warn { color: var(--guide-warn); font-weight: 600; }
  .tag { font-size: 0.8rem; border-radius: 6px; padding: 1px 8px; border: 1.5px solid var(--muted); }
  .tag.heuristic { border-style: dashed; }
  .evidence { list-style: none; padding: 0; margin: 0; }
  .evidence li { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin-bottom: 10px; }
  .evidence .meta { grid-column: 2; color: var(--muted); font-size: 0.85rem; }
  .badge { display: inline-grid; place-items: center; width: 1.7em; height: 1.7em; border-radius: 6px; font: 700 15px ui-monospace, monospace; border: 1.5px solid currentColor; }
  .badge.sm { width: 1.5em; height: 1.5em; font-size: 13px; }
  .badge.dashed { border-style: dashed; }
  .r-io { color: var(--r-io); background: var(--r-io-bg); } .r-mutation { color: var(--r-mutation); background: var(--r-mutation-bg); }
  .r-control { color: var(--r-control); background: var(--r-control-bg); } .r-pure { color: var(--r-pure); background: var(--r-pure-bg); }
  .r-unknown { color: var(--r-unknown); background: var(--r-unknown-bg); }
  code { font-size: 0.9em; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .tests { list-style: none; padding: 0; margin: 4px 0 0; font-size: 0.95rem; }
  .tests li { margin-bottom: 4px; overflow-wrap: anywhere; }
  .oc { font-size: 0.75rem; border-radius: 6px; padding: 0 6px; border: 1px solid var(--border); margin-right: 4px; }
  .oc.passed { color: var(--ok); border-color: var(--ok); } .oc.failed, .oc.error, .oc.timeout, .oc.crashed { color: var(--bad); border-color: var(--bad); }
</style>
