// Brief §6.8 report: one model, shown on the Report tab and serialized to Markdown.
// No source code is included unless `excerpts` is on, and possible secrets are always masked.
import type { Analysis, Certainty, CheckId } from '../analysis/model';
import type { Workspace } from '../lib/types';
import type { RunOutcome } from '../sandbox/client';
import type { Outcome } from '../sandbox/protocol';
import type { FunctionRisk } from '../review/risk';
import type { Checks } from '../review/checks';
import { CHECK_LABEL, CHECK_ORDER } from '../review/checks';
import type { SpecItem, SpecLink } from '../review/spec';
import { lineCoverage } from '../sandbox/coverage';
import { maskLines } from '../lib/segments';
import { SECRET_PATTERNS, maskValue } from '../analysis/secrets';

export interface ReportInput {
  workspace: Workspace;
  analysis: Analysis | null;
  testRun: RunOutcome | null;
  risks: FunctionRisk[];
  checks: Checks;
  reviews: Record<string, { done: boolean; note: string }>;
  progress: { pct: number; done: number; total: number; weighted: boolean };
  spec: SpecItem[];
  links: SpecLink[];
  testPaths: Set<string>;
  excerpts: boolean;
  generatedAt: Date;
}

export interface ReportFinding { path: string; line: number; endLine: number; detail: string; certainty: Certainty; rule: string; source: string; lang: string; excerpt?: { first: number; lines: string[] } }
export interface ReportModel {
  generated: string;
  files: { path: string; lines: number; lang: string; isTest: boolean }[];
  diff: boolean;
  progress: ReportInput['progress'];
  unreviewed: { name: string; path: string; line: number; score: number; band: string; findings: number; lang: string; excerpt?: { first: number; lines: string[] } }[];
  findings: { check: CheckId; label: string; items: ReportFinding[] }[];
  findingCount: number;
  tests: { ran: boolean; counts: Partial<Record<Outcome, number>>; notable: { name: string; file: string; outcome: Outcome; message?: string }[]; notes: string[] };
  untested: { path: string; lines: string; count: number }[] | null;
  notes: { name: string; path: string; line: number; done: boolean; note: string }[];
  spec: { text: string; linked: string[] }[];
  excerpts: boolean;
}

const band = (s: number) => (s >= 67 ? 'high' : s >= 34 ? 'medium' : 'low');

/** "3, 5–8, 12" from sorted line numbers. */
export function ranges(nums: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return out.join(', ');
}

/** Masks anything that looks like a known key format in free text (test messages). */
export function maskText(t: string): string {
  let s = t;
  for (const p of SECRET_PATTERNS) s = s.replace(new RegExp(p.re.source, 'g'), (m) => maskValue(m));
  return s;
}

export function buildReport(inp: ReportInput): ReportModel {
  const { workspace: ws, analysis } = inp;
  const faOf = (path: string) => analysis?.files.find((f) => f.path === path) ?? null;
  const srcOf = (path: string) => ws.files.find((f) => f.path === path) ?? null;
  const excerpt = (path: string, line: number, endLine: number) => {
    if (!inp.excerpts) return undefined;
    const src = srcOf(path);
    if (!src) return undefined;
    const last = Math.min(endLine, line + 4);
    const lines = src.text.split('\n').slice(line - 1, last);
    return { first: line, lines: maskLines(lines, line, faOf(path)?.secrets ?? []) };
  };

  // "High-risk" = the reading queue's top 5 (ignoring score 0, which has no risk signal at all) plus anything rated high.
  const top5 = new Set(inp.risks.filter((r) => r.score > 0).slice(0, 5).map((r) => r.id));
  const unreviewed = inp.risks.filter((r) => !inp.reviews[r.id]?.done && (top5.has(r.id) || band(r.score) === 'high'))
    .map((r) => ({ name: r.fn.qualname, path: r.path, line: r.fn.span.line, score: r.score, band: band(r.score), findings: inp.checks.byFn.get(r.id)?.length ?? 0, lang: faOf(r.path)?.lang ?? '', excerpt: excerpt(r.path, r.fn.span.line, r.fn.span.line) }));

  const findings = CHECK_ORDER.map((check) => ({
    check, label: CHECK_LABEL[check],
    items: inp.checks.all.filter((f) => f.check === check).map((f) => ({ path: f.path, line: f.line, endLine: f.endLine, detail: f.detail, certainty: f.certainty, rule: f.rule, source: f.source, lang: faOf(f.path)?.lang ?? '', excerpt: excerpt(f.path, f.line, f.endLine) })),
  })).filter((g) => g.items.length);

  const run = inp.testRun;
  const counts: Partial<Record<Outcome, number>> = {};
  const notable: ReportModel['tests']['notable'] = [];
  if (run) for (const t of run.tests) {
    const r = run.results[t.id];
    if (!r) continue;
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    if (r.outcome !== 'passed' && r.outcome !== 'skipped') notable.push({ name: r.name, file: r.file, outcome: r.outcome, message: inp.excerpts && r.message ? maskText(r.message).slice(0, 600) : undefined });
  }

  let untested: ReportModel['untested'] = null;
  if (run && Object.keys(run.coverage).length) {
    untested = [];
    for (const [path, cov] of Object.entries(run.coverage)) {
      if (inp.testPaths.has(path)) continue;
      const miss = [...cov.statements].sort((a, b) => a - b).filter((n) => lineCoverage(cov, n)?.state === 'miss');
      if (miss.length) untested.push({ path, lines: ranges(miss), count: miss.length });
    }
  }

  const notes = inp.risks.filter((r) => inp.reviews[r.id]?.note || inp.reviews[r.id]?.done)
    .map((r) => ({ name: r.fn.qualname, path: r.path, line: r.fn.span.line, done: !!inp.reviews[r.id]?.done, note: inp.reviews[r.id]?.note ?? '' }));

  const label = (kind: string, ref: string) => {
    if (kind === 'function') { const r = inp.risks.find((x) => x.id === ref); return r ? `${r.fn.qualname}() (${r.path})` : ref; }
    return 'test: ' + (run?.results[ref]?.name ?? run?.tests.find((t) => t.id === ref)?.name ?? ref);
  };
  const spec = inp.spec.map((s) => ({ text: s.text, linked: inp.links.filter((l) => l.item === s.id).map((l) => label(l.kind, l.ref)) }));

  return {
    generated: inp.generatedAt.toLocaleString(),
    files: ws.files.map((f) => ({ path: f.path, lines: f.lines, lang: f.lang, isTest: f.isTest })),
    diff: !!ws.diff.trim(),
    progress: inp.progress,
    unreviewed, findings, findingCount: inp.checks.all.length,
    tests: { ran: !!run, counts, notable, notes: run?.notes ?? [] },
    untested, notes, spec, excerpts: inp.excerpts,
  };
}

const OUTCOME_ORDER: Outcome[] = ['passed', 'failed', 'error', 'timeout', 'crashed', 'skipped'];

function fence(lines: string[], first: number, lang: string): string {
  const body = lines.map((l, i) => `${String(first + i).padStart(4)}  ${l}`).join('\n');
  const f = body.includes('```') ? '~~~~' : '```';
  return `${f}${lang === 'python' ? 'python' : lang === 'javascript' ? 'js' : ''}\n${body}\n${f}`;
}

export function toMarkdown(m: ReportModel): string {
  const o: string[] = [];
  o.push('# Lynceus review report', '');
  o.push(`Generated ${m.generated} on this device. No code left the device.`);
  o.push(m.excerpts ? 'Code excerpts: **included** (possible secrets masked).' : 'Code excerpts: not included (no source code in this report).', '');
  o.push('## Summary', '');
  o.push(`- **Reviewed:** ${m.progress.pct}% of ${m.progress.weighted ? 'risk-weighted code' : 'functions'} (${m.progress.done} of ${m.progress.total} functions)`);
  o.push(`- **Findings:** ${m.findingCount}`);
  o.push(`- **Tests:** ${m.tests.ran ? OUTCOME_ORDER.filter((k) => m.tests.counts[k]).map((k) => `${m.tests.counts[k]} ${k}`).join(', ') || 'no results' : 'not run'}`);
  o.push(`- **Files:** ${m.files.length} (${m.files.reduce((s, f) => s + f.lines, 0)} lines)${m.diff ? ', with a diff' : ''}`, '');

  o.push('## Unreviewed high-risk functions', '', '*The reading queue\'s top 5 (score above 0) plus any rated high, not yet marked reviewed.*', '');
  if (!m.unreviewed.length) o.push('None: every function in the top 5 (score above 0) or rated high is marked reviewed.', '');
  for (const u of m.unreviewed) {
    o.push(`- \`${u.name}()\` in ${u.path}:${u.line}: risk **${u.score}** (${u.band})${u.findings ? `, ${u.findings} finding${u.findings === 1 ? '' : 's'}` : ''}`);
    if (u.excerpt) o.push('', fence(u.excerpt.lines, u.excerpt.first, u.lang), '');
  }
  o.push('');

  o.push('## Findings', '');
  if (!m.findings.length) o.push('No findings.', '');
  for (const g of m.findings) {
    o.push(`### ${g.label} (${g.items.length})`, '');
    for (const f of g.items) {
      o.push(`- ${f.path}:${f.line}${f.endLine !== f.line ? `–${f.endLine}` : ''}: ${f.detail}  `);
      o.push(`  *${f.certainty}* · rule \`${f.rule}\` · evidence: ${f.source}`);
      if (f.excerpt) o.push('', fence(f.excerpt.lines, f.excerpt.first, f.lang), '');
    }
    o.push('');
  }

  o.push('## Test results', '');
  if (!m.tests.ran) o.push('Tests were not run, so there is no test evidence in this review.', '');
  else {
    o.push(OUTCOME_ORDER.filter((k) => m.tests.counts[k]).map((k) => `${m.tests.counts[k]} ${k}`).join(', ') || 'No results.', '');
    for (const t of m.tests.notable) {
      o.push(`- **${t.outcome}**: ${t.name} (${t.file})`);
      if (t.message) { const f = t.message.includes('```') ? '~~~~' : '```'; o.push('', `${f}\n${t.message}\n${f}`, ''); }
    }
    if (m.tests.notable.length && !m.excerpts) o.push('', '*Failure messages are left out because they can quote code. Tick "Include code excerpts" to add them.*');
    for (const n of m.tests.notes) o.push(`- Note: ${n}`);
    o.push('');
  }

  o.push('## Lines not run by the provided tests', '');
  if (!m.untested) o.push('No coverage: tests were not run.', '');
  else if (!m.untested.length) o.push('Every statement was run by at least one test or at import.', '');
  else { for (const u of m.untested) o.push(`- ${u.path}: ${u.count} statement line${u.count === 1 ? '' : 's'} (lines ${u.lines})`); o.push(''); }

  if (m.notes.length) {
    o.push('## Review notes', '');
    for (const n of m.notes) o.push(`- ${n.done ? '[x]' : '[ ]'} \`${n.name}()\` (${n.path}:${n.line})${n.note ? `: ${n.note}` : ''}`);
    o.push('');
  }
  if (m.spec.length) {
    o.push('## Spec coverage (links made by the reviewer)', '');
    for (const s of m.spec) o.push(`- ${s.text}: ${s.linked.length ? s.linked.join('; ') : '**not linked**'}`);
    o.push('');
  }
  o.push('## Files', '');
  for (const f of m.files) o.push(`- ${f.path} (${f.lang}, ${f.lines} lines${f.isTest ? ', tests' : ''})`);
  o.push('', '---', '*Every finding comes from the syntax tree, the test run or the diff. Lynceus uses no AI.*', '');
  return o.join('\n');
}
