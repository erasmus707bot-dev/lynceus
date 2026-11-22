<script lang="ts">
  import { ROLE_LETTER, ROLE_LABEL, ROLE_ORDER } from '../analysis/model';
  import { app } from '../lib/session.svelte';
  const what: Record<string, string> = {
    io: 'Talks to the outside world: printing, files, network, databases, time, randomness, environment, the page (DOM).',
    mutation: 'Changes state that lives beyond this line: attributes, list/dict items, globals, in-place methods like append/push.',
    unknown: 'Calls something Lynceus cannot see (not in your upload, not on a known list). It is never assumed to be safe.',
    control: 'Changes which code runs next: if, loops, try/except, return, raise/throw, break, await, yield.',
    pure: 'Just computes a value from local data, or calls only known-pure built-ins (len, max, Math.*…).',
  };
</script>

<section class="help" aria-labelledby="help-h">
  <h2 id="help-h">How to read this</h2>
  <p>Every line that starts a statement gets a <strong>letter</strong> in the gutter. Color is optional: switch a role on with the chips above the code to tint those lines.</p>
  <ul class="roles">
    {#each ROLE_ORDER as r (r)}
      <li><span class="badge r-{r}">{ROLE_LETTER[r]}</span> <strong>{ROLE_LABEL[r]}</strong><br /><span class="muted">{what[r]}</span></li>
    {/each}
  </ul>
  <h3>Certain or heuristic</h3>
  <ul>
    <li><span class="badge solid">M</span> <strong>Certain</strong>: provable from the syntax tree, or a Python/JavaScript built-in.</li>
    <li><span class="badge dashed">M</span> <strong>Heuristic</strong>: a name-based guess (for example <code>.append()</code>, or a library like <code>requests</code>). Dashed outline, lighter tint.</li>
  </ul>
  <p>If a line has several roles, the most review-worthy wins, in this order: I/O, mutation, unknown, control, pure. Tap the line to see all of them.</p>
  <h3>Nesting</h3>
  <ul>
    <li>Thin colored lines show how deep a line is nested.</li>
    <li><span class="flag">⚑</span> and a <span class="warnline">thick orange guide</span> mark blocks nested deeper than {app.settings.nestingLimit} levels.</li>
    <li>Tap <strong>▾</strong> to collapse a block. Its summary (loop/branches/writes/calls) comes straight from the syntax tree, never from an AI.</li>
  </ul>
  <h3>Reading passes</h3>
  <ul>
    <li><strong>Lines</strong>: every line with its role letter (this view).</li>
    <li><strong>Shape</strong>: an outline of files, classes and functions. Pick one to see who calls it and what it calls. Calls are marked <em>in your code</em>, <em>known</em> (on a rule list) or <em>unresolved</em>.</li>
    <li><strong>Flow</strong>: lines the tests ran get a green edge; the rest are dimmed and labelled "not run by the provided tests". Code that can never run (after a return, or under <code>if False</code>) is labelled <strong>unreachable</strong>. Without a test run, Flow only marks unreachable code.</li>
    <li><strong>Intent</strong>: link each spec bullet to the functions and tests that cover it. Suggestions are word matches and count only once you confirm them. A function is flagged as possible <strong>scaffolding</strong> when tests ran, none of its lines ran, and no spec bullet links to it.</li>
  </ul>
  <h3>Risk score (Queue tab)</h3>
  <p>0–100, from complexity, nesting, side-effect lines, untested lines and whether the diff touched it. <strong>High</strong> is 67 or more, <strong>medium</strong> 34–66, <strong>low</strong> below 34. Tap a score to see every factor and its points. Missing evidence (no tests, no diff) is said out loud, and its weight moves to the other factors.</p>
  <h3>Findings <span class="warnm">⚠</span></h3>
  <p>A <span class="warnm">⚠</span> in the gutter marks where a finding starts: unused code, duplicated blocks, unreachable code, broad or empty catches, mutable default arguments, <code>==</code> in JavaScript, possible secrets, TODO/FIXME and placeholder bodies. Tap the line for the rule and whether it is certain or heuristic. All of them are listed on the Report tab.</p>
  <p><strong>Possible secrets are masked</strong> as <code>sk_l••••</code>. Tap <strong>show</strong> to see one string; it stays out of every export.</p>
  <h3>Lens</h3>
  <p>Turn on <strong>Lens</strong> above the code, then tap a name: every read (<strong class="lr">R</strong>) and write (<strong class="lw">W</strong>) of that exact variable lights up, using the language's scope rules, so a same-named variable elsewhere stays dark. Tap a function's first line to keep only it, its callers and its callees bright. <kbd>Esc</kbd> clears it.</p>
  <h3>Reviewed</h3>
  <p>Tick <strong>Reviewed</strong> on a function in the Queue or Shape view and add a one-line note if you like. The Queue shows the share of risk-weighted code you have reviewed.</p>
  <h3>Tapping a line</h3>
  <p>Shows the exact rule that fired, what it matched, and whether it is certain or heuristic. Press <kbd>Esc</kbd> or tap the line again to clear.</p>
</section>

<style>
  .help h2 { margin-top: 0; }
  .help h3 { font-size: 1.05rem; margin: 1em 0 0.3em; }
  ul { padding-left: 0; list-style: none; margin: 0.4em 0; }
  li { margin: 0 0 0.6em; }
  .badge { display: inline-grid; place-items: center; width: 1.7em; height: 1.7em; border-radius: 6px; font: 700 15px ui-monospace, monospace; border: 1.5px solid currentColor; }
  .badge.dashed { border-style: dashed; }
  .r-io { color: var(--r-io); background: var(--r-io-bg); } .r-mutation { color: var(--r-mutation); background: var(--r-mutation-bg); }
  .r-control { color: var(--r-control); background: var(--r-control-bg); } .r-pure { color: var(--r-pure); background: var(--r-pure-bg); }
  .r-unknown { color: var(--r-unknown); background: var(--r-unknown-bg); }
  .flag { color: var(--guide-warn); font-weight: 700; }
  .warnline { border-left: 3px solid var(--guide-warn); padding-left: 4px; }
  .warnm { color: var(--bad); font-weight: 700; }
  .lr { color: var(--lens-read); } .lw { color: var(--lens-write); }
  kbd { border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; font-size: 0.9em; }
</style>
