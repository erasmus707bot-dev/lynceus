// @vitest-environment node
// Phase 5: Python scope-aware bindings and extra checks, run in real Pyodide like the app.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FileAnalysis } from '../../src/analysis/model';

const require = createRequire(import.meta.url);
const SRC = readFileSync(path.resolve(__dirname, '../../src/analysis/python/analyze.py'), 'utf8');
const RULES = readFileSync(path.resolve(__dirname, '../../rules/python.json'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let py: any;

beforeAll(async () => {
  const { loadPyodide } = require('pyodide');
  py = await loadPyodide({ indexURL: path.dirname(require.resolve('pyodide/package.json')) + '/' });
  py.runPython(SRC);
}, 60000);

function run(files: Record<string, string>): FileAnalysis[] {
  py.globals.set('LYNCEUS_IN', JSON.stringify({ files: Object.entries(files).map(([p, t]) => ({ path: p, text: t })), rules: JSON.parse(RULES) }));
  return JSON.parse(py.runPython('analyze_json(LYNCEUS_IN)'));
}
const find = (fa: FileAnalysis, check: string) => (fa.findings ?? []).filter((f) => f.check === check).map((f) => [f.line, f.certainty, f.detail]);

const SAMPLE = `import os, json
from collections import defaultdict
API_KEY = "sk_live_a1B2c3D4e5F6g7H8i9J0"

def total(items, seen=[]):
    t = 0
    for it in items:
        t += it
    unused = 5
    a, b = divmod(t, 2)
    try:
        os.remove("x")
    except Exception:
        pass
    return t + a

def stub():
    pass  # TODO: write it

def outer():
    x = 1
    def inner():
        nonlocal x
        x += 1
        return x
    return [x for x in range(3)], inner

class K:
    y = 2
    def m(self):
        return y
`;

describe('Python bindings (lens)', () => {
  it('reads, writes and nonlocal resolve to the right scope; comprehension names are separate', () => {
    const [fa] = run({ 'main.py': SAMPLE });
    const t = fa.bindings!.find((b) => b.name === 't')!;
    expect(t.refs.map((r) => [r.line, r.access])).toEqual([[6, 'decl'], [8, 'readwrite'], [10, 'read'], [15, 'read']]);
    const xs = fa.bindings!.filter((b) => b.name === 'x');
    expect(xs).toHaveLength(2);
    expect(xs[0].refs.map((r) => r.line)).toEqual([21, 24, 25]); // outer's x, written by inner through nonlocal
    expect(xs[1].certainty).toBe('heuristic');                     // the comprehension's own x
    expect(xs[1].refs.every((r) => r.line === 26)).toBe(true);
  });

  it('a method does not see class-level names (Python rule); function names point at their function', () => {
    const [fa] = run({ 'main.py': SAMPLE });
    const y = fa.bindings!.find((b) => b.name === 'y')!;
    expect(y.refs.map((r) => r.line)).toEqual([29]);
    expect(fa.bindings!.find((b) => b.name === 'total')!.fnTarget).toBe(fa.functions.find((f) => f.name === 'total')!.id);
  });

  it('columns are string indices even after non-ASCII text', () => {
    const [fa] = run({ 'main.py': 'def f():\n    s = "héllo"; n = 1\n    return n\n' });
    const n = fa.bindings!.find((b) => b.name === 'n')!;
    expect(n.refs[0]).toMatchObject({ line: 2, col: 17, endCol: 18 });
  });
});

describe('Python extra checks', () => {
  it('finds each planted problem with the right certainty', () => {
    const [fa] = run({ 'main.py': SAMPLE });
    expect(find(fa, 'unused-import').map((f) => f[2])).toEqual(['"json" is imported but never used', '"defaultdict" is imported but never used']);
    expect(find(fa, 'unused-variable').map((f) => [f[0], f[1]])).toEqual([[9, 'certain'], [10, 'heuristic']]);
    expect(find(fa, 'mutable-default')[0].slice(0, 2)).toEqual([5, 'certain']);
    expect(find(fa, 'broad-catch')[0][2]).toMatch(/except Exception[\s\S]*silently ignored/);
    expect(find(fa, 'placeholder').map((f) => f[2])).toEqual(['stub() only says pass']);
    expect(find(fa, 'todo').map((f) => f[2])).toEqual(['TODO comment: write it']);
    const s = find(fa, 'secret');
    expect(s[0][1]).toBe('certain');
    expect(String(s[0][2])).not.toContain('a1B2c3D4');
    expect(fa.secrets![0]).toEqual({ line: 3, col: 11, endLine: 3, endCol: 39 });
  });

  it('bare except, mutable default call, __all__ exports, re-exports in __init__.py, abstract stubs left alone', () => {
    const [fa, init] = run({
      'main.py': `from abc import abstractmethod
__all__ = ["helper"]
import sys
def helper(x=dict()):
    try:
        return x
    except:
        return None
class Base:
    @abstractmethod
    def run(self):
        ...
`,
      'pkg/__init__.py': 'from .core import thing\n',
    });
    expect(find(fa, 'broad-catch')[0][2]).toMatch(/bare `except:`/);
    expect(find(fa, 'mutable-default')[0][2]).toMatch(/dict\(\)/);
    expect(fa.bindings!.find((b) => b.name === 'helper')!.exported).toBe(true);
    expect(find(fa, 'unused-import').map((f) => f[2])).toEqual(['"sys" is imported but never used']);
    expect(find(fa, 'placeholder')).toEqual([]);
    expect(find(init, 'unused-import')[0][1]).toBe('heuristic');
  });

  it('duplicate windows hash the same for the same shape with different names', () => {
    const body = (v: string, w: string) => `    ${v} = 0\n    for ${w} in items:\n        if ${w}.ok:\n            ${v} += ${w}.n * 2\n        else:\n            ${v} -= 1\n    return ${v}`;
    const [fa] = run({ 'main.py': `def one(items):\n${body('t', 'x')}\n\ndef two(items):\n${body('acc', 'it')}\n` });
    const byHash = new Map<string, number[]>();
    for (const w of fa.dupWindows!) byHash.set(w.hash, [...(byHash.get(w.hash) ?? []), w.line]);
    expect([...byHash.values()].some((l) => l.includes(2) && l.includes(11))).toBe(true);
  });
});
