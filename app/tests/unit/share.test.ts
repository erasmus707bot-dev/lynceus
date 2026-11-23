// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { interpretShare } from '../../src/lib/share';

const base = { title: '', text: '', url: '', files: [], dropped: [] };

describe('Share to Lynceus', () => {
  it('puts shared text in the paste box and keeps a code-like title as the file name', () => {
    const r = interpretShare({ ...base, title: 'calc.py', text: 'def f():\n    return 1\n' });
    expect(r.pasteText).toContain('def f()');
    expect(r.pasteName).toBe('calc.py');
    expect(r.notice).toMatch(/paste box/);
  });
  it('ignores a title that is not a file name', () => {
    expect(interpretShare({ ...base, title: 'Look at this', text: 'x = 1' }).pasteName).toBe('');
  });
  it('accepts code files and zips, and lists everything else with a reason', () => {
    const zip = zipSync({ 'proj/a.ts': strToU8('export const a = 1;'), 'proj/b.png': new Uint8Array([1]) });
    const r = interpretShare({ ...base, files: [
      { name: 'm.py', bytes: strToU8('x = 1') }, { name: 'p.zip', bytes: zip }, { name: 'photo.jpg', bytes: new Uint8Array([1, 2]) },
    ], dropped: ['huge.js'] });
    expect(r.files.map((f) => f.path).sort()).toEqual(expect.arrayContaining(['m.py']));
    expect(r.files.some((f) => /a\.ts$/.test(f.path))).toBe(true);
    expect(r.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(['photo.jpg', 'huge.js']));
    expect(r.notice).toMatch(/2 shared files added/);
  });
  it('explains that links cannot be opened', () => {
    const r = interpretShare({ ...base, text: 'https://example.com/x.py' });
    expect(r.pasteText).toBe('');
    expect(r.notice).toMatch(/never goes online/);
  });
});
