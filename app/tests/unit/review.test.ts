import { describe, it, expect } from 'vitest';
import { JsAnalyzer } from '../../src/analysis/js/adapter';
import { makeFile } from '../../src/lib/files';
import { applyDiff } from '../../src/review/diff';
import { scoreFunctions, DEFAULT_WEIGHTS, validWeights } from '../../src/review/risk';
import { buildGraph } from '../../src/review/callgraph';
import { parseSpec, suggest, words } from '../../src/review/spec';
import { scaffolding } from '../../src/review/scaffolding';
import type { Analysis } from '../../src/analysis/model';

const SRC = `function tiny(a) {
  return a + 1;
}
function busy(items, log) {
  let n = 0;
  for (const it of items) {
    if (it.ok && it.v > 0) {
      while (it.retry) {
        if (it.x) {
          log.write(it);
          it.retry--;
        }
      }
    }
  }
  save(n);
  return tiny(n);
}
`;
const analysis = (src = SRC): Analysis => ({ files: new JsAnalyzer().analyze([makeFile('a.js', src)]), ms: 0 });

describe('risk score (hand-computed)', () => {
  it('without tests or diff: complexity/nesting/effects only, weights scaled to 100, marked no test evidence', () => {
    const r = scoreFunctions(analysis(), null, null);
    const busy = r.find((x) => x.fn.name === 'busy')!;
    // busy: complexity = 1 + for + if + && + while + if = 6 → (6-1)/10 = 0.5
    //       depth 4 → 0.8;  side-effect lines: log.write (I/O, heuristic), it.retry-- (mutation), save(n) (unknown) = 3 → 3/8 = 0.375
    //       active weights 25+15+15 = 55 → scaled: 45.45, 27.27, 27.27
    //       score = 45.455*0.5 + 27.273*0.8 + 27.273*0.375 = 22.73 + 21.82 + 10.23 = 54.77 → 55
    expect(busy.factors.find((f) => f.key === 'complexity')).toMatchObject({ raw: 'complexity 6', value: 0.5, weight: 45.5 });
    expect(busy.factors.find((f) => f.key === 'nesting')).toMatchObject({ raw: 'max depth 4', value: 0.8 });
    expect(busy.factors.find((f) => f.key === 'effects')).toMatchObject({ raw: '3 side-effect lines', value: 0.375 });
    expect(busy.factors.find((f) => f.key === 'uncovered')).toMatchObject({ active: false, weight: 0, raw: 'no test evidence' });
    expect(busy.factors.find((f) => f.key === 'failing')).toMatchObject({ active: false, weight: 0 });
    expect(busy.score).toBe(55);
    expect(busy.noTestEvidence).toBe(true);
    expect(r[0].fn.name).toBe('busy');
    const tiny = r.find((x) => x.fn.name === 'tiny')!;
    expect(tiny.score).toBe(0);
  });

  it('with coverage and a diff (no failing-test list): five factors, weights scaled from 80 to 100', () => {
    const cov = { 'a.js': { statements: [2, 5, 6, 7, 8, 9, 10, 11, 16, 17], lines: { 2: ['t'], 5: ['t'], 6: ['t'], 7: ['t'], 16: ['t'], 17: ['t'] } as Record<number, string[]> } };
    const diff = applyDiff(`--- a/a.js\n+++ b/a.js\n@@ -16,2 +16,2 @@\n-  keep(n);\n+  save(n);\n   return tiny(n);\n`, [{ path: 'a.js', text: SRC }]);
    expect(diff.problems).toEqual([]);
    expect(diff.changed['a.js']).toEqual([16]);
    const busy = scoreFunctions(analysis(), cov, diff).find((x) => x.fn.name === 'busy')!;
    // own statement lines: 5,6,7,8,9,10,11,16,17 → 9 with coverage, not run: 8,9,10,11 = 4 → 4/9 = 0.444
    // active 25+15+15+15+10 = 80 → ×1.25: 31.25, 18.75, 18.75, 18.75, 12.5
    // score = 31.25*0.5 + 18.75*0.8 + 18.75*0.375 + 18.75*0.4444 + 12.5*1 = 15.63 + 15 + 7.03 + 8.33 + 12.5 = 58.49 → 58
    expect(busy.factors.find((f) => f.key === 'uncovered')).toMatchObject({ active: true, raw: '4 of 9 statements not run', weight: 18.8 });
    expect(busy.factors.find((f) => f.key === 'diff')).toMatchObject({ active: true, value: 1, raw: 'changed in the diff' });
    expect(busy.score).toBe(58);
    expect(busy.changed).toBe(true);
    expect(busy.noTestEvidence).toBe(false);
    // Test 't' failed: busy ran during it → all six factors at their default weights:
    // 25*0.5 + 15*0.8 + 15*0.375 + 15*0.4444 + 10*1 + 20*1 = 12.5 + 12 + 5.63 + 6.67 + 10 + 20 = 66.79 → 67
    const withFail = scoreFunctions(analysis(), cov, diff, DEFAULT_WEIGHTS, new Map([['t', 'the test']])).find((x) => x.fn.name === 'busy')!;
    expect(withFail.factors.find((f) => f.key === 'failing')).toMatchObject({ active: true, value: 1, weight: 20, raw: 'ran during 1 failing test: the test' });
    expect(withFail.score).toBe(67);
    // A failing test that never touched it: active, value 0
    const notHere = scoreFunctions(analysis(), cov, diff, DEFAULT_WEIGHTS, new Map([['other', 'x']])).find((x) => x.fn.name === 'busy')!;
    expect(notHere.factors.find((f) => f.key === 'failing')).toMatchObject({ active: true, value: 0, raw: 'no failing test ran it' });
  });

  it('saved weights from before the failing factor migrate', () => {
    expect(validWeights({ complexity: 30, nesting: 20, effects: 20, uncovered: 20, diff: 10 })).toEqual(DEFAULT_WEIGHTS);
    expect(validWeights({ complexity: 50, nesting: 20, effects: 20, uncovered: 20, diff: 10 })).toEqual({ complexity: 50, nesting: 20, effects: 20, uncovered: 20, diff: 10, failing: 20 });
  });

  it('custom weights are honoured and normalised', () => {
    const r = scoreFunctions(analysis(), null, null, { ...DEFAULT_WEIGHTS, complexity: 0 });
    const busy = r.find((x) => x.fn.name === 'busy')!;
    // only nesting + effects, 20+20 → 50/50: 50*0.8 + 50*0.375 = 58.75 → 59
    expect(busy.score).toBe(59);
  });
});

describe('diff parsing', () => {
  const files = [{ path: 'src/a.js', text: 'one\ntwo\nthree\n' }];
  it('matches by path suffix and marks added lines', () => {
    const d = applyDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n one\n-TWO\n+two\n three\n', files);
    expect(d.changed['src/a.js']).toEqual([2]);
    expect(d.hunks).toBe(1);
  });
  it('reports hunks that do not match the loaded code and files that are not loaded', () => {
    const d = applyDiff('--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n uno\n+dos\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n+x\n', files);
    expect(d.changed['src/a.js']).toEqual([]);
    expect(d.problems.map((p) => p.reason)).toEqual([expect.stringMatching(/Hunk doesn't match the loaded code: line 1/), expect.stringMatching(/not in the loaded code/)]);
  });
  it('says so when the text is not a unified diff', () => {
    expect(applyDiff('just some words', files).problems[0].reason).toMatch(/No unified-diff file headers/);
  });
});

describe('call graph', () => {
  it('callers and callees, with unresolved calls', () => {
    const a = analysis();
    const g = buildGraph(a);
    const tiny = a.files[0].functions.find((f) => f.name === 'tiny')!;
    const busy = a.files[0].functions.find((f) => f.name === 'busy')!;
    expect(g.callers.get(tiny.id)!.map((c) => c.from?.fn.name)).toEqual(['busy']);
    expect(g.callees.get(busy.id)!.map((c) => [c.name, c.kind])).toEqual([['log.write', 'known'], ['save', 'unresolved'], ['tiny', 'local']]);
  });
});

describe('spec links', () => {
  it('parses bullets (or plain lines when there are none)', () => {
    expect(parseSpec('Intro\n- Adds tax to the cart total\n* Rejects empty carts\n1. Logs refunds').map((s) => s.text)).toEqual(['Adds tax to the cart total', 'Rejects empty carts', 'Logs refunds']);
    expect(parseSpec('First rule\n\nSecond rule').map((s) => s.id)).toEqual(['spec:1', 'spec:3']);
  });
  it('suggests links by shared words, skipping existing links', () => {
    expect(words('applyCartTax_total items')).toEqual(['apply', 'cart', 'tax', 'total', 'item']);
    const items = parseSpec('- Cart total includes tax');
    const s = suggest(items, [{ kind: 'function', ref: 'f1', label: 'cartTotal' }, { kind: 'function', ref: 'f2', label: 'sendEmail' }], []);
    expect(s).toEqual([{ item: 'spec:1', kind: 'function', ref: 'f1', label: 'cartTotal', shared: ['cart', 'total'] }]);
    expect(suggest(items, [{ kind: 'function', ref: 'f1', label: 'cartTotal' }], [{ item: 'spec:1', kind: 'function', ref: 'f1', how: 'manual' }])).toEqual([]);
  });
});

describe('possible scaffolding', () => {
  const src = `function used() {\n  return 1;\n}\nfunction unused() {\n  return 2;\n}\n`;
  const a = analysis(src);
  const cov = { 'a.js': { statements: [2, 5], lines: { 2: ['t'] } as Record<number, string[]> } };
  const risks = scoreFunctions(a, cov, null);
  it('flags functions no test reached and no spec item links to', () => {
    const f = scaffolding(a, cov, risks, [], []);
    expect(f.map((x) => risks.find((r) => r.id === x.id)!.fn.name)).toEqual(['unused']);
    expect(f[0].reason).toMatch(/No test ran any of its 1 statement, and no spec was given/);
  });
  it('a manual spec link clears the flag; no flags without test evidence', () => {
    const unused = risks.find((r) => r.fn.name === 'unused')!;
    expect(scaffolding(a, cov, risks, parseSpec('- x'), [{ item: 'spec:1', kind: 'function', ref: unused.id, how: 'manual' }])).toEqual([]);
    expect(scaffolding(a, null, risks, [], [])).toEqual([]);
  });
});
