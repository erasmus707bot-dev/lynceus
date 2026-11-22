import { describe, it, expect } from 'vitest';
import { countLines, guessLang, isTestPath, langFromPath } from '../../src/lib/detect';

describe('langFromPath', () => {
  it('maps extensions', () => {
    expect(langFromPath('a/b.py')).toBe('python');
    expect(langFromPath('x.MJS')).toBe('javascript');
    expect(langFromPath('x.cjs')).toBe('javascript');
    expect(langFromPath('README.md')).toBeNull();
    expect(langFromPath('Makefile')).toBeNull();
  });
});

describe('guessLang (heuristic)', () => {
  it('spots Python', () => {
    const r = guessLang('import os\n\ndef f(x):\n    if x:\n        return None\n    return self.y\n');
    expect(r.lang).toBe('python'); expect(r.confident).toBe(true);
  });
  it('spots JavaScript', () => {
    const r = guessLang("const x = require('y');\nfunction f(a) {\n  return a => a + 1;\n}\nmodule.exports = { f };\n");
    expect(r.lang).toBe('javascript'); expect(r.confident).toBe(true);
  });
  it('is not confident on ambiguous text', () => {
    expect(guessLang('x = 1').confident).toBe(false);
  });
});

describe('isTestPath', () => {
  it('python', () => {
    expect(isTestPath('tests/test_calc.py', 'python')).toBe(true);
    expect(isTestPath('calc_test.py', 'python')).toBe(true);
    expect(isTestPath('calc.py', 'python')).toBe(false);
  });
  it('javascript', () => {
    expect(isTestPath('src/a.test.js', 'javascript')).toBe(true);
    expect(isTestPath('src/a.spec.mjs', 'javascript')).toBe(true);
    expect(isTestPath('src/__tests__/a.js', 'javascript')).toBe(true);
    expect(isTestPath('src/a.js', 'javascript')).toBe(false);
  });
});

describe('countLines', () => {
  it('counts', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });
});
