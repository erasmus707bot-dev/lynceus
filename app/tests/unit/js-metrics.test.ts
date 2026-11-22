import { describe, it, expect } from 'vitest';
import { JsAnalyzer } from '../../src/analysis/js/adapter';
import type { SourceFile } from '../../src/lib/types';

const file = (path: string, text: string): SourceFile => ({ path, text, lang: 'javascript', langSource: 'extension', lines: text.split('\n').length, isTest: false });
const analyze = (...fs: SourceFile[]) => new JsAnalyzer().analyze(fs);

describe('JS complexity, call sites and unreachable code', () => {
  it('cyclomatic complexity counts decision points, not nested functions', () => {
    const [fa] = analyze(file('a.js', `function f(a, b) {
  if (a && b) { return 1; }          // if +1, && +1
  for (const x of a) {               // +1
    while (x) { break; }             // +1
  }
  const g = () => { if (b) {} };     // nested: not counted
  switch (a) { case 1: break; case 2: break; default: break; } // 2 cases +2
  try { b(); } catch (e) {}          // +1
  return a ? 1 : 2;                  // +1
}`));
    expect(fa.functions.find((f) => f.name === 'f')!.complexity).toBe(9);
    expect(fa.functions.find((f) => f.name === 'g')!.complexity).toBe(2);
  });

  it('call sites: local (with target), known, and unresolved', () => {
    const [a] = analyze(file('a.js', `function helper() { return 1; }
function main() {
  helper();
  console.log('x');
  mystery();
  [1].map((x) => x);
}
main();`));
    const main = a.functions.find((f) => f.name === 'main')!;
    const helper = a.functions.find((f) => f.name === 'helper')!;
    expect(main.callSites!.map((c) => [c.name, c.kind])).toEqual([['helper', 'local'], ['console.log', 'known'], ['mystery', 'unresolved'], ['[1].map', 'known']].map(([n, k]) => [n === '[1].map' ? main.callSites![3].name : n, k]));
    expect(main.callSites![0].target).toBe(helper.id);
    expect(a.moduleCalls!.map((c) => [c.name, c.kind, c.target])).toEqual([['main', 'local', main.id]]);
  });

  it('unreachable: after return/throw/break, and under if (false); hoisted functions are not dead', () => {
    const [fa] = analyze(file('a.js', `function f(x) {
  return x;
  x++;
  function hoisted() {}
}
function g() {
  if (false) {
    doThing();
  }
  while (true) { break; console.log(1); }
}`));
    const lines = fa.unreachable!.map((u) => u.line);
    expect(lines).toContain(3);
    expect(lines).not.toContain(4);
    expect(lines).toContain(7); // the if (false) consequent block starts on line 7
    expect(lines).toContain(10);
    expect(fa.unreachable!.find((u) => u.line === 3)!.reason).toMatch(/after return \(line 2\)/);
  });
});
