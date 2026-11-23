// Risk score per function (brief §6.4). Every number is reproducible by hand:
//   score = Σ effectiveWeight_i × value_i, rounded, where value_i is in 0..1.
// Scales (chosen by Scott, 2026-11-22):
//   complexity  value = clamp((cyclomatic − 1) / 10)        1 → 0, 11 or more → 1
//   nesting     value = clamp(maxDepth / 5)
//   effects     value = clamp(sideEffectLines / 8)          lines whose role is mutation, I/O or unknown call
//   uncovered   value = notRunStatements / statementsWithCoverage   (only when tests ran)
//   diff        value = 1 if any of its lines changed, else 0      (only when a diff was supplied)
//   failing     value = 1 if a failing test ran any of its lines, else 0   (only when tests ran; added 2026-11-22)
// A factor with no evidence (no tests run, no diff supplied) is left out, and the remaining weights
// are scaled up proportionally so they still add to 100. Without tests the score is marked "no test evidence".
import type { Analysis, FunctionInfo, Statement } from '../analysis/model';
import type { FileCoverage } from '../sandbox/protocol';
import { lineCoverage } from '../sandbox/coverage';
import type { DiffResult } from './diff';

export type FactorKey = 'complexity' | 'nesting' | 'effects' | 'uncovered' | 'diff' | 'failing';
export type Weights = Record<FactorKey, number>;
export const DEFAULT_WEIGHTS: Weights = { complexity: 25, nesting: 15, effects: 15, uncovered: 15, diff: 10, failing: 20 };
/** The defaults before the failing-test factor existed (Phase 4–6); saved weights equal to these move to the new defaults. */
export const OLD_DEFAULT_WEIGHTS = { complexity: 30, nesting: 20, effects: 20, uncovered: 20, diff: 10 };
export const FACTOR_ORDER: FactorKey[] = ['complexity', 'nesting', 'effects', 'uncovered', 'diff', 'failing'];
export const FACTOR_LABEL: Record<FactorKey, string> = {
  complexity: 'Cyclomatic complexity', nesting: 'Max nesting depth', effects: 'Side-effect lines', uncovered: 'Uncovered lines', diff: 'In the diff', failing: 'Ran during a failing test',
};
export const FACTOR_SCALE: Record<FactorKey, string> = {
  complexity: '(complexity − 1) ÷ 10, capped at 1',
  nesting: 'depth ÷ 5, capped at 1',
  effects: 'lines ÷ 8, capped at 1',
  uncovered: 'statements not run ÷ statements',
  diff: '1 if any line changed, else 0',
  failing: '1 if a failing test ran any of its lines, else 0',
};

export interface Factor {
  key: FactorKey;
  active: boolean;
  raw: string;        // the raw number(s) behind the factor, in words
  value: number;      // 0..1
  baseWeight: number; // the weight as configured
  weight: number;     // effective weight after redistribution (0 when inactive)
  points: number;     // weight × value
  note?: string;      // why it is inactive, if it is
}

export interface FunctionRisk {
  id: string;
  path: string;
  fn: FunctionInfo;
  score: number;
  factors: Factor[];
  noTestEvidence: boolean;
  changed: boolean;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Statements that belong directly to this function (not to functions nested inside it). */
export function ownStatements(fn: FunctionInfo, statements: Statement[]): Statement[] {
  return statements.filter((s) => s.fn === fn.id);
}

/** Outcomes that count as "failing" for the risk factor: the code under test misbehaved. 'error' (could not run) and 'skipped' do not. */
export const FAILING_OUTCOMES = ['failed', 'timeout', 'crashed'];

/**
 * failing: test id -> test name, for every test whose outcome is in FAILING_OUTCOMES (null when no tests ran).
 * A function "ran during a failing test" when that test's coverage context includes one of its own statement lines.
 * It shows the function ran, not that it caused the failure.
 */
export function scoreFunctions(analysis: Analysis | null, coverage: Record<string, FileCoverage> | null, diff: DiffResult | null, weights: Weights = DEFAULT_WEIGHTS, failing: Map<string, string> | null = null): FunctionRisk[] {
  if (!analysis) return [];
  const out: FunctionRisk[] = [];
  for (const fa of analysis.files) {
    if (!fa.ok) continue;
    const cov = coverage?.[fa.path] ?? null;
    const changedLines = new Set(diff?.changed[fa.path] ?? []);
    for (const fn of fa.functions) {
      const own = ownStatements(fn, fa.statements);
      const cc = fn.complexity ?? 1;
      const depth = fn.maxLevel;
      const effects = own.filter((s) => s.role === 'mutation' || s.role === 'io' || s.role === 'unknown').length;
      const ownLines = [...new Set(own.map((s) => s.span.line))];
      const withCov = ownLines.map((l) => lineCoverage(cov, l)).filter((x) => x !== null);
      const notRun = withCov.filter((x) => x!.state === 'miss').length;
      const hasCov = !!cov && withCov.length > 0;
      const inDiff = [...changedLines].some((l) => l >= fn.span.line && l <= fn.span.endLine);
      const failedHere = new Set<string>();
      if (failing && hasCov) for (const l of ownLines) for (const t of lineCoverage(cov, l)?.tests ?? []) if (failing.has(t)) failedHere.add(failing.get(t)!);
      const raw: Record<FactorKey, { active: boolean; value: number; raw: string; note?: string }> = {
        complexity: { active: true, value: clamp((cc - 1) / 10), raw: `complexity ${cc}` },
        nesting: { active: true, value: clamp(depth / 5), raw: `max depth ${depth}` },
        effects: { active: true, value: clamp(effects / 8), raw: `${effects} side-effect line${effects === 1 ? '' : 's'}` },
        uncovered: hasCov
          ? { active: true, value: notRun / withCov.length, raw: `${notRun} of ${withCov.length} statements not run` }
          : { active: false, value: 0, raw: 'no test evidence', note: coverage ? 'Tests ran, but none of them produced coverage for this file.' : 'No tests have been run, so this weight is shared out over the other factors.' },
        diff: diff?.supplied
          ? { active: true, value: inDiff ? 1 : 0, raw: inDiff ? 'changed in the diff' : 'not changed in the diff' }
          : { active: false, value: 0, raw: 'no diff supplied', note: 'No diff was pasted, so this weight is shared out over the other factors.' },
        failing: hasCov && failing
          ? { active: true, value: failedHere.size ? 1 : 0, raw: failedHere.size ? `ran during ${failedHere.size} failing test${failedHere.size === 1 ? '' : 's'}: ${[...failedHere].slice(0, 3).join(', ')}${failedHere.size > 3 ? ', …' : ''}` : 'no failing test ran it' }
          : { active: false, value: 0, raw: 'no test evidence', note: coverage ? 'Tests ran, but none of them produced coverage for this file.' : 'No tests have been run, so this weight is shared out over the other factors.' },
      };
      const activeSum = FACTOR_ORDER.reduce((n, k) => n + (raw[k].active ? Math.max(0, weights[k]) : 0), 0);
      const factors: Factor[] = FACTOR_ORDER.map((k) => {
        const r = raw[k];
        const weight = r.active && activeSum > 0 ? (Math.max(0, weights[k]) * 100) / activeSum : 0;
        return { key: k, active: r.active, raw: r.raw, value: round1(r.value * 100) / 100, baseWeight: weights[k], weight: round1(weight), points: round1(weight * r.value), note: r.note };
      });
      const score = Math.round(factors.reduce((n, f) => n + (f.active && activeSum > 0 ? (Math.max(0, weights[f.key]) * 100 / activeSum) * raw[f.key].value : 0), 0));
      out.push({ id: fn.id, path: fa.path, fn, score, factors, noTestEvidence: !hasCov, changed: inDiff });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.fn.span.line - b.fn.span.line);
}

export function validWeights(w: unknown): Weights | null {
  if (!w || typeof w !== 'object') return null;
  const o = { ...(w as Record<string, unknown>) };
  // Saved before the failing-test factor existed: the old defaults become the new defaults; custom weights keep their values and get failing 20.
  if (o.failing === undefined) {
    if ((Object.keys(OLD_DEFAULT_WEIGHTS) as (keyof typeof OLD_DEFAULT_WEIGHTS)[]).every((k) => Number(o[k]) === OLD_DEFAULT_WEIGHTS[k])) return { ...DEFAULT_WEIGHTS };
    o.failing = DEFAULT_WEIGHTS.failing;
  }
  const r = {} as Weights;
  for (const k of FACTOR_ORDER) {
    const v = Number(o[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1000) return null;
    r[k] = v;
  }
  return r;
}
