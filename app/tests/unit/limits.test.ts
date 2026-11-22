import { describe, it, expect } from 'vitest';
import { checkLimits } from '../../src/lib/limits';
import { DEFAULTS } from '../../src/lib/settings';

const files = (n: number, lines: number) => Array.from({ length: n }, () => ({ lines }));

describe('checkLimits (defaults: warn 5,000 lines, stop 30,000 lines or 200 files)', () => {
  it('ok', () => expect(checkLimits(files(3, 100), DEFAULTS).level).toBe('ok'));
  it('warns above 5,000 lines', () => expect(checkLimits(files(1, 5001), DEFAULTS).level).toBe('warn'));
  it('exactly 5,000 is ok', () => expect(checkLimits(files(1, 5000), DEFAULTS).level).toBe('ok'));
  it('stops above 30,000 lines', () => {
    const r = checkLimits(files(1, 30001), DEFAULTS);
    expect(r.level).toBe('stop'); expect(r.message).toContain('30,001');
  });
  it('stops above 200 files', () => expect(checkLimits(files(201, 1), DEFAULTS).level).toBe('stop'));
  it('respects custom settings', () => expect(checkLimits(files(1, 50), { warnLines: 10, maxLines: 40, maxFiles: 5 }).level).toBe('stop'));
});
