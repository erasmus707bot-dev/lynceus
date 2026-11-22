import { describe, it, expect } from 'vitest';
import { JsAnalyzer } from '../../src/analysis/js/adapter';
import type { SourceFile } from '../../src/lib/types';

const file = (path: string, text: string): SourceFile => ({ path, text, lang: 'javascript', langSource: 'extension', lines: text.split('\n').length, isTest: false });
const analyze = (...fs: SourceFile[]) => new JsAnalyzer().analyze(fs);
const checks = (fa: { findings?: { check: string; line: number; certainty: string; detail: string }[] }, check: string) => (fa.findings ?? []).filter((f) => f.check === check);

describe('JS scope-aware bindings (lens)', () => {
  it('matches reads and writes to the right declaration, not a same-named variable elsewhere', () => {
    const [fa] = analyze(file('a.js', `function a() {
  let total = 0;
  total += 2;
  return total;
}
function b() {
  const total = 5;
  return total;
}
export { a, b };`));
    const totals = fa.bindings!.filter((x) => x.name === 'total');
    expect(totals).toHaveLength(2);
    const inA = totals.find((t) => t.refs[0].line === 2)!;
    expect(inA.refs.map((r) => [r.line, r.access])).toEqual([[2, 'decl'], [3, 'readwrite'], [4, 'read']]);
    expect(inA.fn).toBe(fa.functions.find((f) => f.name === 'a')!.id);
    const inB = totals.find((t) => t.refs[0].line === 7)!;
    expect(inB.refs.map((r) => r.line)).toEqual([7, 8]);
    expect(inA.certainty).toBe('certain');
  });

  it('block scopes are separate, and function names point at their function', () => {
    const [fa] = analyze(file('a.js', `export function f(x) {
  if (x) { let y = 1; y++; }
  let y = 2;
  return helper(y);
}
function helper(v) { return v; }`));
    const ys = fa.bindings!.filter((b) => b.name === 'y');
    expect(ys.map((y) => y.refs.map((r) => r.line)).sort((a, b) => a[0] - b[0])).toEqual([[2, 2], [3, 4]]);
    const h = fa.bindings!.find((b) => b.name === 'helper')!;
    expect(h.kind).toBe('function');
    expect(h.fnTarget).toBe(fa.functions.find((f) => f.name === 'helper')!.id);
    expect(fa.bindings!.find((b) => b.name === 'f')!.exported).toBe(true);
  });
});

describe('JS extra checks', () => {
  it('unused variables and imports, certain; _names and exports are left alone', () => {
    const [fa] = analyze(file('a.js', `import { readFile, unusedThing } from './fs.js';
const _private = 1;
export const kept = 2;
function f() {
  let seen = 0;
  seen = 1;
  const never = 3;
  return readFile();
}
export { f };`));
    const vars = checks(fa, 'unused-variable').map((f) => f.detail);
    expect(vars).toEqual(['"seen" is assigned but never read', '"never" is declared but never used']);
    expect(checks(fa, 'unused-import').map((f) => [f.detail, f.certainty])).toEqual([['"unusedThing" is imported but never used', 'certain']]);
  });

  it('top-level names in a classic script are heuristic', () => {
    const [fa] = analyze(file('a.js', `var config = 1;\nfunction go() { return 2; }\ngo();`));
    expect(checks(fa, 'unused-variable')[0].certainty).toBe('heuristic');
  });

  it('empty catch, empty promise catch, loose equality', () => {
    const [fa] = analyze(file('a.js', `export function f(a, p) {
  try { a(); } catch (e) {}
  p.catch(() => {});
  if (a == 1) {}
  if (a != null) {}
  return a === 2;
}`));
    expect(checks(fa, 'broad-catch').map((f) => [f.line, f.certainty])).toEqual([[2, 'certain'], [3, 'heuristic']]);
    expect(checks(fa, 'loose-equality').map((f) => [f.line, f.certainty])).toEqual([[4, 'certain'], [5, 'heuristic']]);
  });

  it('secrets: known formats are certain, name hints heuristic; the value is masked and its span recorded', () => {
    const key = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0';
    const [fa] = analyze(file('a.js', `const stripe = "${key}";
const config = { password: "hunter22x" };
const msg = "hello world, nothing here";
import x from "./not-a-secret-but-a-path-1234567890abcdef.js";
export { stripe, config, msg, x };`));
    const s = checks(fa, 'secret');
    expect(s.map((f) => [f.line, f.certainty])).toEqual([[1, 'certain'], [2, 'heuristic']]);
    expect(s[0].detail).not.toContain(key);
    expect(s[0].detail).toContain('sk_l');
    expect(fa.secrets![0]).toEqual({ line: 1, col: 16, endLine: 1, endCol: 16 + key.length });
  });

  it('TODO comments and placeholder bodies', () => {
    const [fa] = analyze(file('a.js', `// TODO: handle refunds
export function refund() {}
export function charge() { throw new Error('not implemented'); }
export function real() { return 1; }
[1].map(() => {});`));
    expect(checks(fa, 'todo').map((f) => f.detail)).toEqual(['TODO comment: handle refunds']);
    expect(checks(fa, 'placeholder').map((f) => f.detail)).toEqual(['refund() has an empty body', 'charge() only throws "not implemented"']);
  });

  it('duplicate windows: same shape with different names hash the same', () => {
    const body = (v: string, w: string) => `  let ${v} = 0;
  for (const ${w} of items) {
    if (${w}.ok) {
      ${v} += ${w}.n * 2;
    }
  }
  return ${v};`;
    const [fa] = analyze(file('a.js', `export function one(items) {\n${body('t', 'x')}\n}\nexport function two(items) {\n${body('sum', 'it')}\n}`));
    const ws = fa.dupWindows!;
    const byHash = new Map<string, number[]>();
    for (const w of ws) byHash.set(w.hash, [...(byHash.get(w.hash) ?? []), w.line]);
    expect([...byHash.values()].some((lines) => lines.includes(2) && lines.includes(11))).toBe(true);
  });
});
