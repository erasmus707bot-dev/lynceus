// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { JsAnalyzer } from '../../src/analysis/js/adapter';
import { makeFile } from '../../src/lib/files';
import type { FileAnalysis, Statement } from '../../src/analysis/model';

const run = (src: string, extra: Record<string, string> = {}) => new JsAnalyzer().analyze([makeFile('main.js', src), ...Object.entries(extra).map(([p, s]) => makeFile(p, s))]);
const at = (fa: FileAnalysis, line: number): Statement => {
  const s = fa.statements.filter((x) => x.span.line === line);
  if (!s.length) throw new Error('no statement on line ' + line);
  return s[0];
};
const role = (src: string, line = 1) => { const st = at(run(src)[0], line); return `${st.role}/${st.certainty}`; };

describe('JS roles: mutation', () => {
  it('attribute assignment', () => expect(role('obj.x = 1')).toBe('mutation/certain'));
  it('subscript assignment', () => expect(role('arr[0] = 1')).toBe('mutation/certain'));
  it('outer variable from a function', () => expect(role('let n = 0;\nfunction f() {\n  n += 1;\n}', 3)).toBe('mutation/certain'));
  it('undeclared global', () => expect(role('function f() {\n  total = 5;\n}', 2)).toBe('mutation/certain'));
  it('local variable is NOT mutation', () => expect(role('function f() {\n  let t = 0;\n  t += 1;\n}', 3)).toBe('pure/certain'));
  it('param reassignment is local', () => expect(role('function f(a) {\n  a = 2;\n}', 2)).toBe('pure/certain'));
  it('push is heuristic mutation', () => expect(role('xs.push(1)')).toBe('mutation/heuristic'));
  it('delete', () => expect(role('delete o.k')).toBe('mutation/certain'));
  it('Object.assign is certain mutation', () => expect(role('Object.assign(a, b)')).toBe('mutation/certain'));
  it('x++ on outer', () => expect(role('let i = 0;\nfunction f() {\n  i++;\n}', 3)).toBe('mutation/certain'));
});

describe('JS roles: I/O', () => {
  it('console.log', () => expect(role('console.log(1)')).toBe('io/certain'));
  it('fetch', () => expect(role('fetch("/x")')).toBe('io/certain'));
  it('Math.random', () => expect(role('const r = Math.random();')).toBe('io/certain'));
  it('process.env read', () => expect(role('const k = process.env.KEY;')).toBe('io/certain'));
  it('document write', () => expect(role('document.title = "x"')).toBe('io/certain'));
  it('innerHTML write is heuristic I/O', () => expect(role('el.innerHTML = "x"')).toBe('io/heuristic'));
  it('fs library is heuristic', () => expect(role("const fs = require('fs');\nfs.writeFileSync('a', 'b');", 2)).toBe('io/heuristic'));
  it('I/O beats mutation on one line', () => expect(role('obj.v = Math.random()')).toBe('io/certain'));
});

describe('JS roles: control', () => {
  it('if', () => expect(role('if (a) {\n  b();\n}').startsWith('control') || role('if (a) {\n  b();\n}') === 'unknown/certain').toBe(true));
  it('if with pure test is control', () => expect(role('if (a > 1) {\n}')).toBe('control/certain'));
  it('for loop', () => expect(role('for (let i = 0; i < 3; i++) {\n}')).toBe('control/certain'));
  it('return', () => expect(role('function f(a) {\n  return a + 1;\n}', 2)).toBe('control/certain'));
  it('throw', () => expect(role('function f() {\n  throw new Error("x");\n}', 2)).toBe('unknown/certain'));
  it('break', () => expect(role('while (true) {\n  break;\n}', 2)).toBe('control/certain'));
  it('await', () => expect(role('async function f(p) {\n  await p;\n}', 2)).toBe('control/certain'));
});

describe('JS roles: pure + unknown', () => {
  it('local arithmetic', () => expect(role('const x = 1 + 2;')).toBe('pure/certain'));
  it('Math.max is pure', () => expect(role('const m = Math.max(1, 2);')).toBe('pure/certain'));
  it('.map is heuristic pure', () => expect(role('const ys = xs.map((x) => x * 2);')).toBe('pure/heuristic'));
  it('unknown function call is unknown, never pure', () => expect(role('doThing(1)')).toBe('unknown/certain'));
  it('unknown method call', () => expect(role('api.frobnicate()')).toBe('unknown/certain'));
  it('shadowed console is not treated as I/O', () => expect(role('function f(console) {\n  console.log(1);\n}', 2)).toBe('unknown/certain'));
});

describe('JS local calls (propagated)', () => {
  it('call to local pure function is pure', () => {
    const fa = run('function add(a, b) {\n  return a + b;\n}\nconst s = add(1, 2);')[0];
    expect(`${at(fa, 4).role}/${at(fa, 4).certainty}`).toBe('pure/certain');
  });
  it('call to local function that logs is I/O', () => {
    const fa = run('function save(x) {\n  console.log(x);\n}\nsave(1);')[0];
    expect(at(fa, 4).role).toBe('io');
    expect(fa.functions.find((f) => f.name === 'save')!.role).toBe('io');
  });
  it('this.method() resolves within a class', () => {
    const fa = run('class C {\n  a() {\n    this.b();\n  }\n  b() {\n    this.n = 1;\n  }\n}')[0];
    expect(at(fa, 3).role).toBe('mutation');
  });
  it('require across files resolves', () => {
    const fa = run("const { log } = require('./util');\nlog(1);", { 'util.js': 'function log(x) {\n  console.log(x);\n}\nmodule.exports = { log };' })[0];
    expect(at(fa, 2).role).toBe('io');
    expect(at(fa, 2).evidence[0].rule).toBe('call.local');
  });
});

describe('JS nesting + summaries', () => {
  const src = 'function f(xs) {\n  let total = 0;\n  for (const x of xs) {\n    if (x % 2) {\n      total += x;\n    }\n    save(total);\n  }\n  return total;\n}';
  const fa = run(src)[0];
  it('levels', () => {
    const loop = fa.blocks.find((b) => b.kind === 'loop')!;
    const iff = fa.blocks.find((b) => b.kind === 'if')!;
    expect(loop.level).toBe(1); expect(iff.level).toBe(2);
    expect(fa.functions[0].maxLevel).toBe(2);
  });
  it('summary from the syntax tree', () => {
    expect(fa.blocks.find((b) => b.kind === 'loop')!.summary).toBe('for…of loop · 2 branches · writes total · calls save()');
  });
  it('deep nesting level counts', () => {
    const deep = run('function g(a) {\n  if (a) {\n    for (;;) {\n      while (a) {\n        if (a) {\n          a--;\n        }\n      }\n    }\n  }\n}')[0];
    expect(Math.max(...deep.blocks.map((b) => b.level))).toBe(4);
  });
});

describe('JS errors', () => {
  it('syntax error is reported with a line, not dropped', () => {
    const fa = run('function (\n')[0];
    expect(fa.ok).toBe(false); expect(fa.error!.line).toBe(1);
  });
});

import { buildLines, hiddenLines } from '../../src/analysis/lines';
describe('line model for the code view', () => {
  const src = 'function f(xs) {\n  for (const x of xs) {\n    if (x) {\n      if (x > 1) {\n        if (x > 2) {\n          console.log(x);\n        }\n      }\n    }\n  }\n}\n';
  const fa = new JsAnalyzer().analyze([makeFile('a.js', src)])[0];
  const lines = buildLines(src, fa, 3);
  it('one row per source line', () => expect(lines).toHaveLength(11));
  it('gutter role on the I/O line', () => { expect(lines[5].role).toBe('io'); expect(lines[5].starts).toBe(true); });
  it('flags the block nested deeper than the limit', () => { expect(lines[4].flagged?.level).toBe(4); expect(lines[3].flagged).toBeNull(); });
  it('guides grow with depth and the over-limit one is marked', () => {
    expect(lines[5].guides.length).toBe(5);
    expect(lines[5].guides.some((g) => g.warn)).toBe(true);
  });
  it('collapsing hides the body but keeps the header', () => {
    const loop = fa.blocks.find((b) => b.kind === 'loop')!;
    const h = hiddenLines(fa, { [loop.id]: true });
    expect(h.has(2)).toBe(false); expect(h.has(3)).toBe(true); expect(h.has(10)).toBe(true);
  });
});
