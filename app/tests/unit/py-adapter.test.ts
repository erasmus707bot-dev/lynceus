// @vitest-environment node
// Runs the real Python adapter (src/analysis/python/analyze.py) inside Pyodide, the same engine the app uses.
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

function run(src: string, extra: Record<string, string> = {}): FileAnalysis[] {
  const files = [{ path: 'main.py', text: src }, ...Object.entries(extra).map(([p, t]) => ({ path: p, text: t }))];
  py.globals.set('LYNCEUS_IN', JSON.stringify({ files, rules: JSON.parse(RULES) }));
  return JSON.parse(py.runPython('analyze_json(LYNCEUS_IN)'));
}
const role = (src: string, line = 1, extra: Record<string, string> = {}) => {
  const fa = run(src, extra)[0];
  if (!fa.ok) return 'ERR ' + fa.error!.message;
  const s = fa.statements.find((x) => x.span.line === line)!;
  return `${s.role}/${s.certainty}`;
};

const CASES: [string, string, number, string][] = [
  ['attribute assignment', 'obj.x = 1', 1, 'mutation/certain'],
  ['subscript assignment', 'd["k"] = 1', 1, 'mutation/certain'],
  ['global write', 'n = 0\ndef f():\n    global n\n    n += 1', 4, 'mutation/certain'],
  ['nonlocal write', 'def f():\n    n = 0\n    def g():\n        nonlocal n\n        n = 2', 5, 'mutation/certain'],
  ['local is not mutation', 'def f():\n    t = 0\n    t += 1', 3, 'pure/certain'],
  ['append is heuristic mutation', 'xs.append(1)', 1, 'mutation/heuristic'],
  ['setattr is certain mutation', 'setattr(o, "a", 1)', 1, 'mutation/certain'],
  ['del item', 'del d["k"]', 1, 'mutation/certain'],
  ['print', 'print(1)', 1, 'io/certain'],
  ['random via import', 'import random\nx = random.randint(1, 2)', 2, 'io/certain'],
  ['random via from-import', 'from random import randint\nx = randint(1, 2)', 2, 'io/certain'],
  ['requests is heuristic', 'import requests\nr = requests.get("u")', 2, 'io/heuristic'],
  ['environment read', 'import os\nk = os.environ["K"]', 2, 'io/certain'],
  ['os.path.join is pure', 'import os\np = os.path.join("a", "b")', 2, 'pure/certain'],
  ['file write method', 'fh.write("x")', 1, 'io/heuristic'],
  ['with open', 'with open("f") as fh:\n    pass', 1, 'io/certain'],
  ['len is pure', 'x = len([1])', 1, 'pure/certain'],
  ['str method is heuristic pure', 'y = s.upper()', 1, 'pure/heuristic'],
  ['map depends on its function', 'ys = list(map(f, xs))', 1, 'pure/heuristic'],
  ['unknown call', 'do_thing()', 1, 'unknown/certain'],
  ['unknown method', 'api.frobnicate()', 1, 'unknown/certain'],
  ['shadowed print is unknown', 'def f(print):\n    print(1)', 2, 'unknown/certain'],
  ['if', 'if a > 1:\n    pass', 1, 'control/certain'],
  ['return', 'def f(a):\n    return a + 1', 2, 'control/certain'],
  ['raise of built-in exception', 'def f():\n    raise ValueError("x")', 2, 'control/certain'],
  ['raise of unknown class', 'def f():\n    raise MyErr("x")', 2, 'unknown/certain'],
  ['await', 'async def f(c):\n    await c', 2, 'control/certain'],
  ['local pure call', 'def add(a, b):\n    return a + b\ns = add(1, 2)', 3, 'pure/certain'],
  ['local I/O call propagates', 'def save(x):\n    print(x)\nsave(1)', 3, 'io/certain'],
  ['self.method resolves', 'class C:\n    def a(self):\n        self.b()\n    def b(self):\n        self.n = 1', 3, 'mutation/certain'],
];

describe('Python roles (in Pyodide)', () => {
  for (const [name, src, line, want] of CASES) it(name, () => expect(role(src, line)).toBe(want));
  it('cross-file from-import resolves to the uploaded function', () => {
    expect(role('from calc import log\nlog(1)', 2, { 'calc.py': 'def log(x):\n    print(x)' })).toBe('io/certain');
  });
});

describe('Python nesting + summaries', () => {
  const fa = () => run('def f(xs):\n    total = 0\n    for x in xs:\n        if x % 2:\n            total += x\n        save(total)\n    return total')[0];
  it('levels and summary', () => {
    const a = fa();
    expect(a.blocks.find((b) => b.kind === 'loop')!.level).toBe(1);
    expect(a.blocks.find((b) => b.kind === 'if')!.level).toBe(2);
    expect(a.blocks.find((b) => b.kind === 'loop')!.summary).toBe('for loop · 2 branches · writes total · calls save()');
    expect(a.functions[0].maxLevel).toBe(2);
  });
  it('elif stays at the same level', () => {
    const a = run('def g(x):\n    if x:\n        pass\n    elif x > 1:\n        pass\n    else:\n        pass')[0];
    expect(a.blocks.filter((b) => b.kind === 'if')).toHaveLength(1);
  });
  it('syntax error reported with line', () => {
    const a = run('def (:\n')[0];
    expect(a.ok).toBe(false); expect(a.error!.line).toBe(1);
  });
});

describe('Python complexity, call sites and unreachable code (in Pyodide)', () => {
  it('cyclomatic complexity counts decision points, not nested functions', () => {
    const [fa] = run(`def f(a, b):
    if a and b:
        return 1
    elif a:
        pass
    for x in a:
        while x:
            break
    try:
        pass
    except ValueError:
        pass
    ys = [y for y in a if y]
    def g():
        if b:
            pass
    return 1 if a else 2
`);
    // if +1, and +1, elif +1, for +1, while +1, except +1, comprehension for +1 and if +1, ternary +1 = 10
    expect(fa.functions.find((f) => f.name === 'f')!.complexity).toBe(10);
    expect(fa.functions.find((f) => f.name === 'g')!.complexity).toBe(2);
  });

  it('call sites: local (with target), known and unresolved; module-level calls too', () => {
    const [fa] = run(`def helper():
    return 1

def main():
    helper()
    print("x")
    mystery()

main()
`);
    const main = fa.functions.find((f) => f.name === 'main')!;
    const helper = fa.functions.find((f) => f.name === 'helper')!;
    expect(main.callSites!.map((c) => [c.name, c.kind])).toEqual([['helper', 'local'], ['print', 'known'], ['mystery', 'unresolved']]);
    expect(main.callSites![0].target).toBe(helper.id);
    expect(fa.moduleCalls!.map((c) => [c.name, c.target])).toEqual([['main', main.id]]);
  });

  it('unreachable: after return/raise/continue, and under if False', () => {
    const [fa] = run(`def f(x):
    return x
    x += 1

def g(xs):
    for x in xs:
        continue
        print(x)
    if False:
        print("never")
    raise ValueError()
    print("after")
`);
    const lines = fa.unreachable!.map((u) => u.line);
    expect(lines).toEqual(expect.arrayContaining([3, 8, 10, 12]));
    expect(fa.unreachable!.find((u) => u.line === 10)!.reason).toMatch(/if False/);
  });
});
