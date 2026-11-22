// Turns per-file coverage into what the Code view shows for one line.
// Wording follows the brief: lines no test executed are "not run by the provided tests", never "dead".
import type { FileCoverage } from './protocol';

export type LineCov = { state: 'run' | 'import' | 'miss'; tests: string[] } | null;

export function lineCoverage(cov: FileCoverage | null | undefined, n: number): LineCov {
  if (!cov || !cov.statements.includes(n)) return null;
  const ids = cov.lines[n] ?? [];
  const tests = ids.filter((t) => t !== '');
  if (tests.length) return { state: 'run', tests };
  if (ids.includes('')) return { state: 'import', tests: [] };
  return { state: 'miss', tests: [] };
}

/** Line numbers where a stretch of "not run" statements begins (each gets one visible label). */
export function missStarts(cov: FileCoverage | null | undefined): Set<number> {
  const out = new Set<number>();
  if (!cov) return out;
  let prevMiss = false;
  for (const n of [...cov.statements].sort((a, b) => a - b)) {
    const miss = lineCoverage(cov, n)?.state === 'miss';
    if (miss && !prevMiss) out.add(n);
    prevMiss = miss;
  }
  return out;
}

export const MISS_LABEL = 'not run by the provided tests';
