<script lang="ts">
  import { app } from '../lib/session.svelte';
  import { buildLines, hiddenLines } from '../analysis/lines';
  import { ROLE_LETTER, ROLE_LABEL, type FileAnalysis } from '../analysis/model';
  import { lineCoverage, missStarts, MISS_LABEL } from '../sandbox/coverage';
  import { review } from '../lib/review.svelte';
  import { lineSegments, type Tok } from '../lib/segments';
  import { CHECK_LABEL } from '../review/checks';

  let { text, fa, path, mode = 'lines' }: { text: string; fa: FileAnalysis | null; path: string; mode?: 'lines' | 'flow' } = $props();

  const flow = $derived(mode === 'flow');
  // Flow always uses coverage when a test run exists; Lines uses it only when the toggle is on.
  const cov = $derived(flow || app.showCoverage ? app.testRun?.coverage[path] ?? null : null);
  const unreach = $derived(flow ? fa?.unreachable ?? [] : []);
  const unreachAt = (n: number) => unreach.find((u) => u.line <= n && n <= u.endLine) ?? null;
  // One "not run" label per stretch, restarting at each function so the label sits in every untested function.
  const starts = $derived(missStarts(cov, (fa?.functions ?? []).map((f) => f.span.line), (n) => !!unreachAt(n)));

  const lines = $derived(buildLines(text, fa, app.settings.nestingLimit));

  // ---- findings (§6.7): a ⚠ in the gutter where a finding starts ----
  const findingStarts = $derived(review.checks.starts.get(path) ?? new Map());

  // ---- lens (§6.6): off by default; tap a name to light up its reads and writes in scope ----
  const lensOn = $derived(app.lens && mode === 'lines');
  const toksByLine = $derived.by(() => {
    const m = new Map<number, Tok[]>();
    if (!lensOn) return m;
    for (const b of fa?.bindings ?? []) for (const r of b.refs) m.set(r.line, [...(m.get(r.line) ?? []), { col: r.col, endCol: r.endCol, binding: b.id, access: r.access }]);
    return m;
  });
  const lensB = $derived(lensOn && app.lensBinding ? fa?.bindings?.find((b) => b.id === app.lensBinding) ?? null : null);
  const accessAt = $derived.by(() => {
    const m = new Map<number, Set<string>>();
    for (const r of lensB?.refs ?? []) m.set(r.line, (m.get(r.line) ?? new Set()).add(r.access === 'read' ? 'R' : r.access === 'readwrite' ? 'RW' : 'W'));
    return m;
  });
  const lensLetter = (n: number) => { const s = accessAt.get(n); if (!s) return ''; return s.has('RW') || (s.has('R') && s.has('W')) ? 'RW' : s.has('W') ? 'W' : 'R'; };
  /** Function lens: the function, its callers and its callees stay bright (this file's part of the call graph). */
  const fnRanges = $derived.by(() => {
    if (!lensOn || !app.lensFn) return null;
    const ranges: [number, number][] = [];
    const me = review.graph.byId.get(app.lensFn);
    if (me && me.path === path) ranges.push([me.fn.span.line, me.fn.span.endLine]);
    for (const c of review.graph.callees.get(app.lensFn) ?? []) { const t = c.target ? review.graph.byId.get(c.target) : null; if (t && t.path === path) ranges.push([t.fn.span.line, t.fn.span.endLine]); }
    for (const c of review.graph.callers.get(app.lensFn) ?? []) if (c.path === path) ranges.push(c.from ? [c.from.fn.span.line, c.from.fn.span.endLine] : [c.line, c.line]);
    return ranges;
  });
  const dimmed = (n: number) => (fnRanges ? !fnRanges.some(([a, b]) => a <= n && n <= b) : lensB ? !accessAt.has(n) : false);
  const fnHeaderAt = $derived(new Map((fa?.functions ?? []).map((f) => [f.span.line, f.id])));
  function tapTok(e: Event, id: string) {
    e.stopPropagation();
    const b = fa?.bindings?.find((x) => x.id === id);
    if (app.lensBinding === id) { app.lensBinding = null; app.lensFn = null; return; }
    app.lensBinding = id;
    app.lensFn = b?.fnTarget ?? null;
  }
  function reveal(e: Event, key: string) { e.stopPropagation(); app.revealed = { ...app.revealed, [key]: !app.revealed[key] }; }
  const hidden = $derived(hiddenLines(fa, app.collapsed));
  const filterClass = $derived(app.roleFilter.map((r) => 'show-' + r).join(' '));

  const cols = $derived(new Map((fa?.blocks ?? []).map((b) => [b.id, b.span.col])));
  /** Guides sit under the first character of their block's header, like an editor's indent guides. */
  const colOf = (id: string) => (cols.get(id) ?? 0) + 0.5;

  /** Only draw a guide where the line has whitespace at that column, so it never strikes through code. */
  function clear(text: string, id: string): boolean {
    const c = cols.get(id) ?? 0;
    const expanded = text.replace(/\t/g, '    ');
    return c >= expanded.length || /\s/.test(expanded[c]);
  }

  function select(n: number) {
    if (lensOn) {
      // tapping a function's first line focuses its call graph; tapping elsewhere clears the lens
      const f = fnHeaderAt.get(n);
      if (f) { app.lensFn = app.lensFn === f && !app.lensBinding ? null : f; app.lensBinding = null; }
      else if (app.lensBinding || app.lensFn) { app.lensBinding = null; app.lensFn = null; }
    }
    app.selectedLine = app.selectedLine === n ? null : n;
  }
  function toggle(id: string, e: Event) { e.stopPropagation(); app.collapsed = { ...app.collapsed, [id]: !app.collapsed[id] }; }
  function onKey(e: KeyboardEvent, n: number) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n); }
  }
</script>

<div class="code {filterClass}" class:wrap={app.wrap} role="group" aria-label="Source code with role markers">
  {#each lines as l (l.n)}
    {#if !hidden.has(l.n)}
      {@const lc = lineCoverage(cov, l.n)}
      {@const ur = unreachAt(l.n)}
      {@const fs = findingStarts.get(l.n) ?? []}
      {@const ll = lensB ? lensLetter(l.n) : ''}
      <div class:lens-dim={dimmed(l.n)} class:lens-hit={!!ll} class="row {l.role ? 'role-' + l.role : ''} {l.certainty ?? ''}" class:selected={app.selectedLine === l.n} class:cov-miss={lc?.state === 'miss' || !!ur}
        class:flow-run={flow && !!lc && lc.state !== 'miss' && !ur} class:unreach={!!ur} data-flow={flow ? (ur ? 'unreachable' : lc?.state ?? '') : undefined}
        role="button" tabindex="0" aria-pressed={app.selectedLine === l.n} data-line={l.n}
        aria-label={`Line ${l.n}${l.role ? ', ' + ROLE_LABEL[l.role] + ', ' + l.certainty : ''}${l.flagged ? ', nested too deep' : ''}${ur ? ', unreachable: ' + ur.reason : lc?.state === 'miss' ? ', ' + MISS_LABEL : ''}${fs.length ? `, ${fs.length} finding${fs.length === 1 ? '' : 's'}: ${fs.map((f: { check: keyof typeof CHECK_LABEL }) => CHECK_LABEL[f.check]).join(', ')}` : ''}${ll ? `, lens: ${ll === 'R' ? 'read' : ll === 'W' ? 'write' : 'read and write'}` : ''}`}
        onclick={() => select(l.n)} onkeydown={(e) => onKey(e, l.n)}>
        <span class="ln" aria-hidden="true">{l.n}</span>
        {#if ll}<span class="letter lens-letter {ll}" aria-hidden="true">{ll}</span>
        {:else}<span class="letter" aria-hidden="true">{l.role && l.starts ? ROLE_LETTER[l.role] : ''}</span>{/if}
        <span class="fold">
          {#if l.blocks.length}
            {@const b = l.blocks[l.blocks.length - 1]}
            <button class="fold-btn" aria-expanded={!app.collapsed[b.id]} aria-label={(app.collapsed[b.id] ? 'Expand ' : 'Collapse ') + b.label}
              onclick={(e) => toggle(b.id, e)}>{app.collapsed[b.id] ? '▸' : '▾'}</button>
          {/if}
        </span>
        <span class="flag" aria-hidden="true" title={l.flagged ? `Nested ${l.flagged.level} levels deep (limit ${app.settings.nestingLimit})` : ''}>{l.flagged ? '⚑' : ''}</span>
        <span class="warn-mark" aria-hidden="true" title={fs.map((f: { check: keyof typeof CHECK_LABEL; detail: string }) => `${CHECK_LABEL[f.check]}: ${f.detail}`).join('\n')} data-testid={fs.length ? 'finding-mark' : undefined}>{fs.length ? '⚠' : ''}</span>
        <code class="src">{#each l.guides.filter((g) => clear(l.text, g.blockId)) as g (g.blockId)}<span class="g c{g.color}" class:warn={g.warn} style:left={`${colOf(g.blockId)}ch`} aria-hidden="true"></span>{/each}{#if l.text}{#each lineSegments(l.text, l.n, path, fa?.secrets ?? [], toksByLine.get(l.n) ?? [], app.revealed) as sg, si (si)}{#if sg.kind === 'text'}{sg.text}{:else if sg.kind === 'tok'}<button type="button" class="tok {sg.access}" class:on={app.lensBinding === sg.binding} onclick={(e) => tapTok(e, sg.binding)} aria-label={`${sg.text}: show every read and write`}>{sg.text}</button>{:else}<span class="secret" class:revealed={sg.revealed} data-testid="secret">{sg.shown}</span>{#if sg.first}<button type="button" class="reveal" onclick={(e) => reveal(e, sg.key)} aria-label={sg.revealed ? 'Hide this possible secret' : 'Show this possible secret'} data-testid="reveal">{sg.revealed ? 'hide' : 'show'}</button>{/if}{/if}{/each}{:else}{' '}{/if}{#if ur && ur.line === l.n}<span class="nr-tag ur-tag" data-testid="unreachable-tag" title={ur.reason}>unreachable</span>{:else if starts.has(l.n) && !ur}<span class="nr-tag">{MISS_LABEL}</span>{/if}</code>
      </div>
      {#each l.blocks.filter((b) => app.collapsed[b.id]) as b (b.id)}
        <div class="summary-row">
          <button class="summary" onclick={(e) => toggle(b.id, e)}>
            <span aria-hidden="true">⋯</span> {b.summary} <span class="muted">(lines {b.headerEnd + 1}–{b.span.endLine} hidden)</span>
          </button>
        </div>
      {/each}
    {/if}
  {/each}
</div>


<style>
  .code { background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; padding: 6px 0; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 16px; line-height: 1.6; }
  .row { display: grid; grid-template-columns: 3.2em 1.6em 1.6em 1.2em 1.2em 1fr; align-items: start; min-height: 1.6em; cursor: pointer; border-left: 3px solid transparent; }
  .row:hover { background: color-mix(in srgb, var(--selected) 45%, transparent); }
  .row.selected { background: var(--selected); }
  .row:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
  .ln { color: var(--muted); text-align: right; padding-right: 0.5em; user-select: none; font-size: 0.85em; line-height: 1.9; }
  .letter { font-weight: 700; text-align: center; user-select: none; }
  .fold, .flag, .warn-mark { text-align: center; user-select: none; }
  .warn-mark { color: var(--bad); font-weight: 700; }
  /* lens */
  .tok { all: unset; cursor: pointer; border-radius: 3px; box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  .tok:focus-visible { outline: 2px solid var(--focus); }
  .tok.on.read { background: var(--lens-read-bg); box-shadow: inset 0 -2px 0 var(--lens-read); }
  .tok.on.write, .tok.on.decl, .tok.on.readwrite { background: var(--lens-write-bg); box-shadow: inset 0 0 0 1.5px var(--lens-write); font-weight: 700; }
  .row.lens-dim { opacity: 0.38; }
  .lens-letter { font-size: 0.8em; }
  .lens-letter.R { color: var(--lens-read); } .lens-letter.W, .lens-letter.RW { color: var(--lens-write); }
  /* secrets: masked unless the reviewer taps show */
  .secret { background: var(--callout-beige); border-radius: 3px; letter-spacing: 0.05em; }
  .secret.revealed { outline: 1.5px dashed var(--bad); }
  .reveal { margin-left: 0.6ch; padding: 0 6px; min-height: 24px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font: 12px/1.6 system-ui, sans-serif; cursor: pointer; vertical-align: 1px; }
  .flag { color: var(--guide-warn); }
  .fold-btn { border: 0; background: none; color: var(--muted); padding: 0; width: 1.6em; min-height: 1.6em; font-size: 0.9em; }
  .g { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid var(--guide-1); pointer-events: none; }
  .g.c1 { border-color: var(--guide-2); } .g.c2 { border-color: var(--guide-3); } .g.c3 { border-color: var(--guide-4); }
  .g.warn { border-left: 3px solid var(--guide-warn); }
  .src { position: relative; white-space: pre; padding-right: 12px; font-size: inherit; tab-size: 4; align-self: stretch; }
  .wrap .src { white-space: pre-wrap; overflow-wrap: anywhere; }

  /* Gutter letters are always shown (never color alone). Tints appear only for roles the reviewer switched on. */
  .row.role-io .letter { color: var(--r-io); }
  .row.role-mutation .letter { color: var(--r-mutation); }
  .row.role-control .letter { color: var(--r-control); }
  .row.role-pure .letter { color: var(--r-pure); }
  .row.role-unknown .letter { color: var(--r-unknown); }
  /* heuristic: dashed outline on the letter; certain: solid */
  .row.heuristic .letter:not(:empty) { outline: 1.5px dashed currentColor; outline-offset: -3px; border-radius: 4px; }
  .show-io .row.role-io, .show-mutation .row.role-mutation, .show-control .row.role-control, .show-pure .row.role-pure, .show-unknown .row.role-unknown { background: var(--tint); border-left-style: solid; }
  .row.role-io { --tint: var(--r-io-bg); border-left-color: transparent; }
  .row.role-mutation { --tint: var(--r-mutation-bg); }
  .row.role-control { --tint: var(--r-control-bg); }
  .row.role-pure { --tint: var(--r-pure-bg); }
  .row.role-unknown { --tint: var(--r-unknown-bg); }
  .show-io .row.role-io { border-left-color: var(--r-io); } .show-mutation .row.role-mutation { border-left-color: var(--r-mutation); }
  .show-control .row.role-control { border-left-color: var(--r-control); } .show-pure .row.role-pure { border-left-color: var(--r-pure); }
  .show-unknown .row.role-unknown { border-left-color: var(--r-unknown); }
  /* heuristic rows are visibly lighter: half tint, dashed edge */
  .row.heuristic { --tint-mix: 50%; }
  [class*='show-'] .row.heuristic { background-image: none; }
  .show-io .row.role-io.heuristic, .show-mutation .row.role-mutation.heuristic, .show-control .row.role-control.heuristic, .show-pure .row.role-pure.heuristic, .show-unknown .row.role-unknown.heuristic {
    background: color-mix(in srgb, var(--tint) 50%, transparent); border-left-style: dashed;
  }
  .row.selected { background: var(--selected) !important; }
  /* Coverage layer: lines no test ran are dimmed and labelled (text label too, never colour alone). */
  .row.cov-miss .src, .row.cov-miss .letter { opacity: 0.5; }
  .row.cov-miss { background-image: repeating-linear-gradient(135deg, transparent 0 6px, var(--cov-miss) 6px 7px); }
  .nr-tag { display: inline-block; margin-left: 1.5ch; padding: 0 8px; border: 1px dashed var(--muted); border-radius: 6px; color: var(--text); opacity: 1; font: 13px/1.6 system-ui, sans-serif; white-space: nowrap; vertical-align: 1px; }
  .row.cov-miss .src:has(.nr-tag) { opacity: 1; color: color-mix(in srgb, var(--text) 50%, transparent); }
  /* Flow pass: lines the tests ran get a solid green edge; unreachable code is dimmed with a cross-hatch. */
  .row.flow-run { border-left-color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, transparent); }
  .row.unreach { background-image: repeating-linear-gradient(45deg, transparent 0 6px, var(--cov-miss) 6px 7px), repeating-linear-gradient(135deg, transparent 0 6px, var(--cov-miss) 6px 7px); }
  .ur-tag { border-style: solid; border-color: var(--bad); }
  .row.unreach .src:has(.ur-tag) { opacity: 1; color: color-mix(in srgb, var(--text) 50%, transparent); }
  .summary-row { padding: 2px 0 2px calc(3.2em + 1.6em + 1.6em + 1.2em + 1.2em); }
  .summary { border: 1px dashed var(--border); background: var(--callout-beige); color: var(--text); border-radius: 8px; padding: 4px 10px; min-height: 36px; text-align: left; font: 15px/1.4 system-ui, sans-serif; }
</style>
