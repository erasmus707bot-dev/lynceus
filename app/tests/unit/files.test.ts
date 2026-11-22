// @vitest-environment node
// (fflate's Uint8Array checks fail across jsdom's separate realm; zip code has no DOM needs.)
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { acceptBytes, makeFile, mergeFiles, normalizePath, readZip } from '../../src/lib/files';

describe('normalizePath', () => {
  it('cleans separators and traversal', () => {
    expect(normalizePath('./a\\b/../c.py')).toBe('a/b/c.py');
    expect(normalizePath('/abs/x.js')).toBe('abs/x.js');
  });
});

describe('makeFile', () => {
  it('uses extension first, manual override wins', () => {
    expect(makeFile('a.js', 'def f(): pass').lang).toBe('javascript');
    expect(makeFile('a.js', 'x', 'python').langSource).toBe('manual');
    expect(makeFile('pasted', 'def f():\n    return 1\n').langSource).toBe('content (heuristic)');
  });
});

describe('readZip', () => {
  const zip = zipSync({
    'proj/': new Uint8Array(),
    'proj/pkg/calc.py': strToU8('def add(a, b):\n    return a + b\n'),
    'proj/tests/test_calc.py': strToU8('from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n'),
    'proj/README.md': strToU8('# hi'),
    'proj/node_modules/x/index.js': strToU8('module.exports = 1'),
    'proj/img.js': new Uint8Array([0, 1, 2, 3]),
    '__MACOSX/proj/._calc.py': strToU8('junk'),
  });
  const r = readZip(zip);
  it('keeps folder structure and strips the single top folder', () => {
    expect(r.files.map((f) => f.path).sort()).toEqual(['pkg/calc.py', 'tests/test_calc.py']);
    expect(r.files.find((f) => f.path === 'tests/test_calc.py')!.isTest).toBe(true);
  });
  it('reports every skipped file with a reason (never silent)', () => {
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    expect(reasons['proj/README.md']).toMatch(/not a Python or JavaScript/);
    expect(reasons['proj/node_modules/x/index.js']).toMatch(/node_modules/);
    expect(reasons['proj/img.js']).toMatch(/binary/);
    expect(reasons['__MACOSX/proj/._calc.py']).toMatch(/__MACOSX/);
  });
  it('reports a broken zip instead of throwing', () => {
    const bad = readZip(new Uint8Array([1, 2, 3, 4]));
    expect(bad.files).toEqual([]); expect(bad.skipped[0].reason).toMatch(/could not read/);
  });
});

describe('acceptBytes / mergeFiles', () => {
  it('later file with same path replaces earlier', () => {
    const a = acceptBytes('x.py', strToU8('a = 1')).file!;
    const b = acceptBytes('x.py', strToU8('a = 2')).file!;
    const m = mergeFiles([a], [b]);
    expect(m).toHaveLength(1); expect(m[0].text).toBe('a = 2');
  });
});
