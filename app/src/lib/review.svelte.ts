// Everything Phase 4 derives from the loaded code, the analysis, the test run and the diff.
// Recomputed automatically when any of them change; nothing here is ever persisted.
import { app } from './session.svelte';
import { applyDiff } from '../review/diff';
import { scoreFunctions } from '../review/risk';
import { buildGraph } from '../review/callgraph';
import { parseSpec, suggest } from '../review/spec';
import { scaffolding } from '../review/scaffolding';

class Review {
  diff = $derived(app.workspace ? applyDiff(app.workspace.diff, app.workspace.files) : null);
  coverage = $derived(app.testRun && Object.keys(app.testRun.coverage).length ? app.testRun.coverage : null);
  // Test files are evidence, not code under review: their functions are left out of the queue,
  // scaffolding and hand-linking (tests are linked as tests, from the test run).
  testPaths = $derived(new Set((app.workspace?.files ?? []).filter((f) => f.isTest).map((f) => f.path)));
  risks = $derived(scoreFunctions(app.analysis, this.coverage, this.diff, app.settings.riskWeights).filter((r) => !this.testPaths.has(r.path)));
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
}

export const review = new Review();

export const band = (score: number) => (score >= 67 ? 'high' : score >= 34 ? 'medium' : 'low');
