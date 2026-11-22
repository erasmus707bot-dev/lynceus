import { describe, it, expect } from 'vitest';
import { getDemo } from '../../src/lib/demo';
import { applyDiff } from '../../src/review/diff';
import { parseSpec } from '../../src/review/spec';
import { detectTests } from '../../src/sandbox/detect-tests';
import { JsAnalyzer } from '../../src/analysis/js/adapter';

describe('bundled demos (Phase 6)', () => {
  for (const id of ['python', 'javascript'] as const) {
    it(`${id}: files, tests, spec and a diff that applies cleanly`, () => {
      const d = getDemo(id);
      expect(d.files.length).toBeGreaterThanOrEqual(2);
      expect(d.files.every((f) => f.lang === id)).toBe(true);
      expect(detectTests(d.files).length).toBe(1);
      expect(parseSpec(d.spec).length).toBeGreaterThanOrEqual(5);
      const r = applyDiff(d.diff, d.files);
      expect(r.problems).toEqual([]);
      expect(Object.keys(r.changed).length).toBe(1);
    });
  }
  it('javascript: the analyzer finds the planted problems', () => {
    const fa = new JsAnalyzer().analyze(getDemo('javascript').files.filter((f) => !f.isTest)).find((f) => f.path === 'cart.js')!;
    const checks = new Set(fa.findings!.map((f) => f.check));
    for (const c of ['secret', 'broad-catch', 'loose-equality', 'placeholder', 'todo']) expect(checks.has(c as never), c).toBe(true);
    expect(fa.functions.find((f) => f.name === 'applyDiscounts')!.maxLevel).toBe(6);
  });
});
