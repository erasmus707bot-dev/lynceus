// Brief §6.7 extra checks, all files together. The adapters report file-local findings; this adds the ones
// that need every file (unused functions, duplicates across files) and turns unreachable code into findings.
import type { Analysis, CheckId, DupWindow, FileAnalysis, Finding, FunctionInfo } from '../analysis/model';
import type { Graph } from './callgraph';

export interface FileFinding extends Finding { path: string }

export interface Checks {
  all: FileFinding[];
  byFn: Map<string, FileFinding[]>;
  /** path -> line -> findings that START on that line (gutter marker) */
  starts: Map<string, Map<number, FileFinding[]>>;
  counts: Partial<Record<CheckId, number>>;
}

export const CHECK_LABEL: Record<CheckId, string> = {
  'unused-function': 'Unused function', 'unused-variable': 'Unused variable', 'unused-import': 'Unused import',
  duplicate: 'Duplicated block', unreachable: 'Unreachable code', 'broad-catch': 'Broad or empty catch',
  'mutable-default': 'Mutable default argument', 'loose-equality': '== instead of ===', secret: 'Possible hardcoded secret',
  todo: 'TODO / FIXME', placeholder: 'Placeholder body',
};
export const CHECK_ORDER: CheckId[] = ['secret', 'broad-catch', 'unreachable', 'mutable-default', 'loose-equality', 'placeholder',
  'unused-function', 'unused-import', 'unused-variable', 'duplicate', 'todo'];

const innermostFn = (fa: FileAnalysis, line: number): FunctionInfo | null =>
  fa.functions.filter((f) => f.span.line <= line && line <= f.span.endLine).sort((a, b) => b.span.line - a.span.line)[0] ?? null;

export function runChecks(analysis: Analysis | null, testPaths: Set<string>, graph: Graph): Checks {
  const all: FileFinding[] = [];
  if (!analysis) return index(all);
  const files = analysis.files.filter((f) => f.ok);
  let n = 0;
  const id = () => `x:${n++}`;

  for (const fa of files) {
    for (const f of fa.findings ?? []) all.push({ ...f, path: fa.path });
    for (const u of fa.unreachable ?? [])
      all.push({ id: id(), path: fa.path, check: 'unreachable', rule: 'unreachable', line: u.line, endLine: u.endLine, fn: innermostFn(fa, u.line)?.id ?? null,
        detail: `can never run: it ${u.reason.replace(/, so it can never run$/, '')}`, certainty: 'certain', source: 'syntax tree' });
  }

  // ---- unused functions (needs every file: imports and the call graph) ----
  for (const fa of files) {
    if (testPaths.has(fa.path)) continue;
    for (const b of fa.bindings ?? []) {
      if (b.kind !== 'function' || !b.fnTarget) continue;
      const fn = graph.byId.get(b.fnTarget)?.fn;
      if (!fn || /^test/i.test(fn.name) || /^__\w+__$/.test(fn.name)) continue;
      const inside = (l: number) => l >= fn.span.line && l <= fn.span.endLine;
      const outsideReads = b.refs.filter((r) => (r.access === 'read' || r.access === 'readwrite') && !inside(r.line)).length;
      if (outsideReads) continue;
      const calledFromElsewhere = (graph.callers.get(fn.id) ?? []).some((c) => c.path !== fa.path || (c.from && c.from.fn.id !== fn.id));
      if (calledFromElsewhere) continue;
      const importedByName = files.some((o) => o.path !== fa.path && (o.bindings ?? []).some((x) => x.kind === 'import' && x.from?.path === fa.path && (x.from.name === fn.name || (fa.lang === 'javascript' && x.from.name === 'default'))));
      if (importedByName) continue;
      const decorated = fa.lang === 'python' && fa.statements.some((s) => s.kind === 'FunctionDef' && s.span.endLine === fn.span.endLine && s.span.line < fn.span.line);
      let certainty: Finding['certainty'] = 'certain';
      let why = '';
      if (decorated) { certainty = 'heuristic'; why = ' (it has a decorator, so a framework may call it)'; }
      else if (b.certainty === 'heuristic') { certainty = 'heuristic'; why = b.note ? ` (${b.note})` : ''; }
      else if (fa.lang === 'javascript' && b.exported) { certainty = 'heuristic'; why = ' (it is exported, so code outside the upload may use it)'; }
      else if (fa.lang === 'python' && !b.fn) { certainty = 'heuristic'; why = ' (top-level Python functions can be imported by code outside the upload)'; }
      all.push({ id: id(), path: fa.path, check: 'unused-function', rule: 'unused.function', line: fn.span.line, endLine: fn.span.line, fn: fn.id,
        detail: `${fn.qualname}() is never called or referenced in the loaded code${why}`, certainty, source: 'syntax tree + call graph' });
    }
  }

  // ---- duplicated blocks (≥ 6 lines, same normalized syntax tree) ----
  all.push(...duplicates(files.filter((f) => !testPaths.has(f.path)), id));

  all.sort((a, b) => files.findIndex((f) => f.path === a.path) - files.findIndex((f) => f.path === b.path) || a.line - b.line || a.check.localeCompare(b.check));
  return index(all);
}

interface Win extends DupWindow { path: string; order: number }

function duplicates(files: FileAnalysis[], id: () => string): FileFinding[] {
  const groups = new Map<string, Win[]>();
  files.forEach((fa, order) => { for (const w of fa.dupWindows ?? []) groups.set(w.hash, [...(groups.get(w.hash) ?? []), { ...w, path: fa.path, order }]); });
  type Match = { a: Win; b: Win; a1: number; a2: number; b1: number; b2: number };
  const matches: Match[] = [];
  for (const ws of groups.values()) {
    if (ws.length < 2) continue;
    ws.sort((x, y) => x.order - y.order || x.line - y.line);
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
      const [a, b] = [ws[i], ws[j]];
      if (a.path === b.path && a.line <= b.endLine && b.line <= a.endLine) continue; // overlapping repeats of one pattern
      matches.push({ a, b, a1: a.line, a2: a.endLine, b1: b.line, b2: b.endLine });
    }
  }
  matches.sort((x, y) => x.a.order - y.a.order || x.b.order - y.b.order || x.a1 - y.a1 || x.b1 - y.b1);
  // merge runs of consecutive windows into one region per side
  const regions: Match[] = [];
  for (const m of matches) {
    const r = regions.find((q) => q.a.path === m.a.path && q.b.path === m.b.path && m.a1 >= q.a1 && m.a1 <= q.a2 + 1 && m.b1 >= q.b1 && m.b1 <= q.b2 + 1 && m.a1 - q.a1 === m.b1 - q.b1);
    if (r) { r.a2 = Math.max(r.a2, m.a2); r.b2 = Math.max(r.b2, m.b2); }
    else regions.push({ ...m });
  }
  const out: FileFinding[] = [];
  const reported: { path: string; l1: number; l2: number; other: string }[] = [];
  const covered = (path: string, l1: number, l2: number, other: string) => reported.some((r) => r.path === path && r.other === other && r.l1 <= l1 && l2 <= r.l2);
  regions.sort((x, y) => (y.a2 - y.a1) - (x.a2 - x.a1));
  for (const r of regions) {
    if (covered(r.a.path, r.a1, r.a2, r.b.path) && covered(r.b.path, r.b1, r.b2, r.a.path)) continue;
    reported.push({ path: r.a.path, l1: r.a1, l2: r.a2, other: r.b.path }, { path: r.b.path, l1: r.b1, l2: r.b2, other: r.a.path });
    const where = (p: string, l1: number, l2: number, self: string) => `${p === self ? '' : p + ' '}lines ${l1}–${l2}`;
    out.push({ id: id(), path: r.a.path, check: 'duplicate', rule: 'duplicate.block', line: r.a1, endLine: r.a2, fn: r.a.fn,
      detail: `lines ${r.a1}–${r.a2} have the same syntax-tree shape as ${where(r.b.path, r.b1, r.b2, r.a.path)} (names and constants ignored)`, certainty: 'certain', source: 'syntax tree' });
    out.push({ id: id(), path: r.b.path, check: 'duplicate', rule: 'duplicate.block', line: r.b1, endLine: r.b2, fn: r.b.fn,
      detail: `lines ${r.b1}–${r.b2} have the same syntax-tree shape as ${where(r.a.path, r.a1, r.a2, r.b.path)} (names and constants ignored)`, certainty: 'certain', source: 'syntax tree' });
  }
  return out;
}

function index(all: FileFinding[]): Checks {
  const byFn = new Map<string, FileFinding[]>();
  const starts = new Map<string, Map<number, FileFinding[]>>();
  const counts: Partial<Record<CheckId, number>> = {};
  for (const f of all) {
    if (f.fn) byFn.set(f.fn, [...(byFn.get(f.fn) ?? []), f]);
    if (!starts.has(f.path)) starts.set(f.path, new Map());
    const m = starts.get(f.path)!;
    m.set(f.line, [...(m.get(f.line) ?? []), f]);
    counts[f.check] = (counts[f.check] ?? 0) + 1;
  }
  return { all, byFn, starts, counts };
}
