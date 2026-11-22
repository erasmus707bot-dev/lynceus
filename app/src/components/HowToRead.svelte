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
  kbd { border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; font-size: 0.9em; }
</style>
