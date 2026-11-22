// "Possible scaffolding" (brief §6.5): code reached by no test AND linked to no spec item.
// Only judged when tests ran for that file; without test evidence nothing is flagged.
import type { FileCoverage } from '../sandbox/protocol';
import { lineCoverage } from '../sandbox/coverage';
import type { FunctionRisk } from './risk';
import { ownStatements } from './risk';
import type { Analysis } from '../analysis/model';
import type { SpecItem, SpecLink } from './spec';

export interface ScaffoldFlag { id: string; reason: string }

export function scaffolding(analysis: Analysis | null, coverage: Record<string, FileCoverage> | null, risks: FunctionRisk[], spec: SpecItem[], links: SpecLink[]): ScaffoldFlag[] {
  if (!analysis || !coverage) return [];
  const flags: ScaffoldFlag[] = [];
  for (const r of risks) {
    const cov = coverage[r.path];
    if (!cov) continue;
    const fa = analysis.files.find((f) => f.path === r.path)!;
    const lines = [...new Set(ownStatements(r.fn, fa.statements).map((s) => s.span.line))];
    const states = lines.map((l) => lineCoverage(cov, l)).filter((x) => x !== null);
    if (!states.length || states.some((s) => s!.state === 'run')) continue;
    if (links.some((l) => l.kind === 'function' && l.ref === r.id)) continue;
    flags.push({ id: r.id, reason: `No test ran any of its ${states.length} statement${states.length === 1 ? '' : 's'}, and ${spec.length ? 'no spec bullet is linked to it' : 'no spec was given to link it to'}.` });
  }
  return flags;
}
