// Everything Phase 4 derives from the loaded code, the analysis, the test run and the diff.
// Recomputed automatically when any of them change; nothing here is ever persisted.
import { app } from './session.svelte';
import { applyDiff } from '../review/diff';
import { scoreFunctions, FAILING_OUTCOMES } from '../review/risk';
import { buildGraph } from '../review/callgraph';
import { parseSpec, suggest } from '../review/spec';
import { scaffolding } from '../review/scaffolding';
import { runChecks } from '../review/checks';

class Review {
  diff = $derived(app.workspace ? applyDiff(app.workspace.diff, app.workspace.files) : null);
  coverage = $derived(app.testRun && Object.keys(app.testRun.coverage).length ? app.testRun.coverage : null);
  // Test files are evidence, not code under review: their functions are left out of the queue,
  // scaffolding and hand-linking (tests are linked as tests, from the test run).
  testPaths = $derived(new Set((app.workspace?.files ?? []).filter((f) => f.isTest).map((f) => f.path)));
  /** test id -> name for tests that failed, timed out or crashed (the "ran during a failing test" factor). */
  failing = $derived(app.testRun ? new Map(Object.values(app.testRun.results).filter((r) => FAILING_OUTCOMES.includes(r.outcome)).map((r) => [r.id, r.name] as const)) : null);
  risks = $derived(scoreFunctions(app.analysis, this.coverage, this.diff, app.settings.riskWeights, this.failing).filter((r) => !this.testPaths.has(r.path)));
  riskById = $derived(new Map(this.risks.map((r) => [r.id, r])));
  graph = $derived(buildGraph(app.analysis));
  spec = $derived(parseSpec(app.workspace?.spec ?? ''));
  links = $derived(app.workspace?.specLinks ?? []);
  scaffold = $derived(scaffolding(app.analysis, this.coverage, this.risks, this.spec, this.links));
  scaffoldById = $derived(new Map(this.scaffold.map((f) => [f.id, f])));
  targets = $derived([
    ...this.risks.map((r) => ({ kind: 'function' as const, ref: r.id, label: r.fn.qualname, where: `${r.path}:${r.fn.span.line}` })),
    ...(app.testRun?.tests ?? []).filter((t) => !t.id.endsWith('::(load)')).map((t) => ({ kind: 'test' as const, ref: t.id, label: t.name, where: t.file })),
  ]);
  suggestions = $derived(suggest(this.spec, this.targets, this.links));
  checks = $derived(runChecks(app.analysis, this.testPaths, this.graph));
  reviews = $derived(app.workspace?.reviews ?? {});
  /** Share of risk-weighted code reviewed: sum of reviewed scores / sum of all scores (by count if every score is 0). */
  progress = $derived.by(() => {
    const total = this.risks.reduce((s, r) => s + r.score, 0);
    const done = this.risks.filter((r) => this.reviews[r.id]?.done);
    const doneScore = done.reduce((s, r) => s + r.score, 0);
    const pct = !this.risks.length ? 0 : total > 0 ? Math.round((doneScore / total) * 100) : Math.round((done.length / this.risks.length) * 100);
    return { pct, done: done.length, total: this.risks.length, weighted: total > 0 };
  });
}

export const review = new Review();

export const band = (score: number) => (score >= 67 ? 'high' : score >= 34 ? 'medium' : 'low');
