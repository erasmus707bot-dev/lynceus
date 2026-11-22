import { describe, it, expect } from 'vitest';
import { JsAnalyzer } from '../../src/analysis/js/adapter';
import { buildGraph } from '../../src/review/callgraph';
import { runChecks } from '../../src/review/checks';
import { scoreFunctions } from '../../src/review/risk';
import { buildReport, toMarkdown, ranges, maskText } from '../../src/report/report';
import { lineSegments, maskLines } from '../../src/lib/segments';
import type { SourceFile, Workspace } from '../../src/lib/types';

const file = (path: string, text: string, isTest = false): SourceFile => ({ path, text, lang: 'javascript', langSource: 'extension', lines: text.split('\n').length, isTest });
const KEY = 'sk_live_' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm';

function setup(files: SourceFile[]) {
  const analysis = { files: new JsAnalyzer().analyze(files), ms: 0 };
  const graph = buildGraph(analysis);
  const testPaths = new Set(files.filter((f) => f.isTest).map((f) => f.path));
  const checks = runChecks(analysis, testPaths, graph);
  return { analysis, graph, checks, testPaths };
}

describe('cross-file checks', () => {
  it('unused functions: certain when private, heuristic when exported, not flagged when imported or recursive-only callers', () => {
    const { checks } = setup([
      file('lib.js', `function hidden() { return 1; }
function rec(n) { return n ? rec(n - 1) : 0; }
export function used() { return 2; }
export function api() { return 3; }
function helper() { return 4; }
export function main() { return helper(); }`),
      file('app.js', `import { used } from './lib.js';\nexport const x = used();`),
    ]);
    const u = checks.all.filter((f) => f.check === 'unused-function').map((f) => [f.detail.split('(')[0], f.certainty]);
    expect(u).toEqual([['hidden', 'certain'], ['rec', 'certain'], ['api', 'heuristic'], ['main', 'heuristic']]);
  });

  it('unreachable code becomes a finding; duplicated blocks across files are paired and merged', () => {
    const block = (v: string) => `  let ${v} = 0;
  for (const it of items) {
    if (it.ok) {
      ${v} += it.n * 2;
    } else {
      ${v} -= 1;
    }
  }
  return ${v};`;
    const { checks } = setup([
      file('a.js', `export function one(items) {\n${block('t')}\n  console.log('never');\n}`),
      file('b.js', `export function two(items) {\n${block('sum')}\n}`),
    ]);
    const un = checks.all.filter((f) => f.check === 'unreachable');
    expect(un.map((f) => [f.path, f.line])).toEqual([['a.js', 11]]);
    const d = checks.all.filter((f) => f.check === 'duplicate');
    expect(d.map((f) => [f.path, f.line, f.endLine])).toEqual([['a.js', 2, 10], ['b.js', 2, 10]]);
    expect(d[0].detail).toContain('b.js lines 2–10');
  });

  it('test files are not checked for unused functions or duplicates', () => {
    const { checks } = setup([file('x.test.js', `function setup() { return 1; }\ntest('a', () => {});`, true)]);
    expect(checks.all.filter((f) => f.check === 'unused-function')).toEqual([]);
  });
});

describe('masking helpers', () => {
  it('lineSegments masks a secret and keeps the rest; maskLines does the same for excerpts', () => {
    const line = `const k = "${KEY}"; // ok`;
    const s = { line: 1, col: 11, endLine: 1, endCol: 11 + KEY.length };
    const segs = lineSegments(line, 1, 'a.js', [s], [], {});
    expect(segs.map((x) => x.kind)).toEqual(['text', 'secret', 'text']);
    expect(segs.map((x) => ('shown' in x ? x.shown : x.text)).join('')).not.toContain(KEY);
    expect(lineSegments(line, 1, 'a.js', [s], [], { 'a.js:1:11': true }).map((x) => ('shown' in x ? x.shown : x.text)).join('')).toContain(KEY);
    expect(maskLines([line], 1, [s])[0]).toBe(`const k = "sk_l••••••••••••"; // ok`);
    expect(maskText(`got ${KEY}`)).not.toContain(KEY);
  });
  it('ranges', () => { expect(ranges([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8'); });
});

describe('report (acceptance #12: secrets masked, no code unless opted in)', () => {
  const src = `export function charge(amount) {
  const stripe = "${KEY}";
  try { return pay(stripe, amount); } catch (e) {}
}
export function unusedHelper() { return 1; }`;
  const files = [file('pay.js', src)];
  const { analysis, checks, testPaths } = setup(files);
  const risks = scoreFunctions(analysis, null, null, { complexity: 30, nesting: 20, effects: 20, uncovered: 20, diff: 10 });
  const ws: Workspace = { files, skipped: [], diff: '', spec: '- Charge the card\n', loadedAt: 0 } as Workspace;
  const base = { workspace: ws, analysis, testRun: null, risks, checks, reviews: { [risks[0].id]: { done: true, note: 'checked the retry' } },
    progress: { pct: 50, done: 1, total: 2, weighted: true }, spec: [{ id: 's0', text: 'Charge the card', line: 1 }], links: [], testPaths, generatedAt: new Date(0) };

  it('without excerpts: no source line appears and the key never appears', () => {
    const md = toMarkdown(buildReport({ ...base, excerpts: false }));
    expect(md).not.toContain(KEY);
    for (const l of src.split('\n')) expect(md).not.toContain(l.trim());
    expect(md).toContain('Possible hardcoded secret');
    expect(md).toContain('sk_l••••');
    expect(md).toContain('rule `secret.stripe-key`');
    expect(md).toContain('checked the retry');
    expect(md).toContain('Charge the card: **not linked**');
    expect(md).toContain('no source code in this report');
  });

  it('with excerpts: code lines appear, but the key is still masked', () => {
    const md = toMarkdown(buildReport({ ...base, excerpts: true }));
    expect(md).toContain('try { return pay(stripe, amount); } catch (e) {}');
    expect(md).toContain('const stripe = "sk_l••••••••••••";');
    expect(md).not.toContain(KEY);
  });
});
