import { describe, it, expect } from 'vitest';
import { detectTests } from '../../src/sandbox/detect-tests';
import { lineCoverage, missStarts } from '../../src/sandbox/coverage';

const f = (path: string, text: string, lang: 'python' | 'javascript' = path.endsWith('.py') ? 'python' : 'javascript') => ({ path, text, lang });

describe('detectTests', () => {
  it('finds pytest files, classes and inline test functions', () => {
    const r = detectTests([
      f('test_calc.py', 'def test_a():\n    pass\n\nclass TestX:\n    def test_b(self):\n        pass\n'),
      f('pkg/calc_test.py', 'async def test_c():\n    pass\n'),
      f('pasted.py', 'def inc(x):\n    return x\n\ndef test_inc():\n    assert inc(1)\n'),
      f('calc.py', 'def add(a, b):\n    return a + b\n'),
      f('conftest.py', 'import pytest\n'),
    ]);
    expect(r).toEqual([
      { path: 'test_calc.py', lang: 'python', count: 2, inline: false },
      { path: 'pkg/calc_test.py', lang: 'python', count: 1, inline: false },
      { path: 'pasted.py', lang: 'python', count: 1, inline: true },
    ]);
  });
  it('finds JS test()/it() in test files and inline', () => {
    const r = detectTests([
      f('a.test.js', "describe('x', () => {\n  it('one', () => {});\n  test.skip('two', () => {});\n});\n"),
      f('b.spec.mjs', "test(`three`, () => {});\n"),
      f('lib.js', "function f() {}\ntest('inline', () => {});\n"),
      f('app.js', "const it = 1;\nconsole.log('test(')\n"),
    ]);
    expect(r.map((x) => [x.path, x.count, x.inline])).toEqual([['a.test.js', 2, false], ['b.spec.mjs', 1, false], ['lib.js', 1, true]]);
  });
});

describe('lineCoverage', () => {
  const cov = { statements: [1, 2, 3, 5, 6], lines: { 1: [''], 2: ['t::a', 't::b'], 5: [''] } };
  it('labels run, import-only and not-run lines; ignores non-statements', () => {
    expect(lineCoverage(cov, 2)).toEqual({ state: 'run', tests: ['t::a', 't::b'] });
    expect(lineCoverage(cov, 1)).toEqual({ state: 'import', tests: [] });
    expect(lineCoverage(cov, 3)).toEqual({ state: 'miss', tests: [] });
    expect(lineCoverage(cov, 4)).toBeNull();
    expect(lineCoverage(null, 2)).toBeNull();
  });
  it('labels only the first line of each stretch of not-run statements', () => {
    expect([...missStarts(cov)]).toEqual([3, 6]);
    expect([...missStarts({ statements: [1, 2, 3], lines: {} })]).toEqual([1]);
  });
});
