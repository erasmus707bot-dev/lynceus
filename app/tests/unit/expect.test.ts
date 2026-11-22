// @vitest-environment node
// Pins the sandbox's Jest-style `expect` against tests/fixtures/expect-snapshots.json.
// Each case lists the matcher, inputs, whether it should pass, and the exact failure message.
// Regenerate deliberately with: UPDATE_EXPECT_SNAPSHOTS=1 npx vitest run tests/unit/expect.test.ts
import { describe, it, expect as vexpect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeExpect, equals, UnsupportedError } from '../../src/sandbox/expect';

const FIXTURE = path.resolve(__dirname, '../fixtures/expect-snapshots.json');
type Case = { matcher: string; actual: unknown; args: unknown[]; not?: boolean; pass: boolean; message: string };

// JSON can't hold undefined, NaN, Map, etc.; these tags stand in for them.
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('$undefined' in o) return undefined;
    if ('$nan' in o) return NaN;
    if ('$map' in o) return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [decode(k), decode(x)]));
    if ('$set' in o) return new Set((o.$set as unknown[]).map(decode));
    if ('$regex' in o) return new RegExp(o.$regex as string);
    if ('$error' in o) return new Error(o.$error as string);
    if ('$throws' in o) return () => { throw new Error(o.$throws as string); };
    if ('$fn' in o) return () => o.$fn;
    if ('$date' in o) return new Date(o.$date as string);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

const INPUTS: Omit<Case, 'pass' | 'message'>[] = [
  { matcher: 'toBe', actual: 3, args: [3] },
  { matcher: 'toBe', actual: 3, args: [4] },
  { matcher: 'toBe', actual: { a: 1 }, args: [{ a: 1 }] },
  { matcher: 'toBe', actual: 3, args: [3], not: true },
  { matcher: 'toBe', actual: { $nan: 1 }, args: [{ $nan: 1 }] },
  { matcher: 'toEqual', actual: { a: [1, { b: 2 }] }, args: [{ a: [1, { b: 2 }] }] },
  { matcher: 'toEqual', actual: { a: 1, b: { $undefined: 1 } }, args: [{ a: 1 }] },
  { matcher: 'toEqual', actual: [1, 2], args: [[1, 2, 3]] },
  { matcher: 'toEqual', actual: { $map: [['k', 1]] }, args: [{ $map: [['k', 1]] }] },
  { matcher: 'toEqual', actual: { $set: [1, 2] }, args: [{ $set: [2, 1] }] },
  { matcher: 'toEqual', actual: { $date: '2026-01-01T00:00:00.000Z' }, args: [{ $date: '2026-01-01T00:00:00.000Z' }] },
  { matcher: 'toStrictEqual', actual: { a: 1, b: { $undefined: 1 } }, args: [{ a: 1 }] },
  { matcher: 'toBeTruthy', actual: 0, args: [] },
  { matcher: 'toBeTruthy', actual: 'x', args: [] },
  { matcher: 'toBeFalsy', actual: '', args: [] },
  { matcher: 'toBeNull', actual: null, args: [] },
  { matcher: 'toBeUndefined', actual: { $undefined: 1 }, args: [] },
  { matcher: 'toBeDefined', actual: { $undefined: 1 }, args: [] },
  { matcher: 'toBeNaN', actual: { $nan: 1 }, args: [] },
  { matcher: 'toBeGreaterThan', actual: 5, args: [3] },
  { matcher: 'toBeGreaterThan', actual: 2, args: [3] },
  { matcher: 'toBeGreaterThanOrEqual', actual: 3, args: [3] },
  { matcher: 'toBeLessThan', actual: 3, args: [3] },
  { matcher: 'toBeLessThanOrEqual', actual: 3, args: [3] },
  { matcher: 'toBeCloseTo', actual: 0.30000000000000004, args: [0.3] },
  { matcher: 'toBeCloseTo', actual: 0.31, args: [0.3, 2] },
  { matcher: 'toContain', actual: [1, 2, 3], args: [2] },
  { matcher: 'toContain', actual: 'hello', args: ['ell'] },
  { matcher: 'toContain', actual: [{ a: 1 }], args: [{ a: 1 }] },
  { matcher: 'toContainEqual', actual: [{ a: 1 }], args: [{ a: 1 }] },
  { matcher: 'toHaveLength', actual: [1, 2], args: [2] },
  { matcher: 'toHaveLength', actual: 'abc', args: [2] },
  { matcher: 'toHaveProperty', actual: { a: { b: [5] } }, args: ['a.b[0]', 5] },
  { matcher: 'toHaveProperty', actual: { a: 1 }, args: ['c'] },
  { matcher: 'toMatch', actual: 'Lynceus', args: [{ $regex: '^Lyn' }] },
  { matcher: 'toMatch', actual: 'Lynceus', args: ['xyz'] },
  { matcher: 'toMatchObject', actual: { a: 1, b: { c: 2, d: 3 } }, args: [{ b: { c: 2 } }] },
  { matcher: 'toThrow', actual: { $throws: 'boom' }, args: [] },
  { matcher: 'toThrow', actual: { $throws: 'boom' }, args: ['oom'] },
  { matcher: 'toThrow', actual: { $throws: 'boom' }, args: [{ $regex: 'b.om' }] },
  { matcher: 'toThrow', actual: { $throws: 'boom' }, args: ['nope'] },
  { matcher: 'toThrow', actual: { $fn: 1 }, args: [] },
  { matcher: 'toThrow', actual: { $fn: 1 }, args: [], not: true },
  { matcher: 'toBeInstanceOf', actual: { $error: 'x' }, args: ['$Error'] },
];

function evaluate(c: Omit<Case, 'pass' | 'message'>): { pass: boolean; message: string } {
  const e = makeExpect();
  const args = c.args.map((a) => (a === '$Error' ? Error : decode(a)));
  const m = (c.not ? (e(decode(c.actual)).not as Record<string, (...a: unknown[]) => void>) : (e(decode(c.actual)) as Record<string, (...a: unknown[]) => void>))[c.matcher];
  try { m(...args); return { pass: true, message: '' }; } catch (err) { return { pass: false, message: (err as Error).message }; }
}

describe('expect shim matches its snapshot fixtures', () => {
  const update = process.env.UPDATE_EXPECT_SNAPSHOTS === '1';
  if (update) writeFileSync(FIXTURE, JSON.stringify(INPUTS.map((c) => ({ ...c, ...evaluate(c) })), null, 2) + '\n');
  const cases: Case[] = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  it('fixture covers every input', () => vexpect(cases.length).toBe(INPUTS.length));
  for (const c of cases) {
    it(`${c.not ? 'not.' : ''}${c.matcher}(${JSON.stringify(c.args)}) on ${JSON.stringify(c.actual)} → ${c.pass ? 'pass' : 'fail'}`, () => {
      vexpect(evaluate(c)).toEqual({ pass: c.pass, message: c.message });
    });
  }
});

describe('expect shim extras', () => {
  it('unsupported matchers fail with a clear reason', () => {
    const e = makeExpect();
    vexpect(() => (e(1) as Record<string, () => void>).toMatchSnapshot()).toThrow(UnsupportedError);
    vexpect(() => (e(1) as Record<string, () => void>).toMatchSnapshot()).toThrow(/is not supported by Lynceus/);
  });
  it('resolves/rejects', async () => {
    const e = makeExpect();
    await (e(Promise.resolve(2)).resolves as Record<string, (x: unknown) => Promise<void>>).toBe(2);
    await vexpect((e(Promise.resolve(2)).rejects as Record<string, () => Promise<void>>).toThrow()).rejects.toThrow(/resolved instead of rejected/);
    await (e(Promise.reject(new Error('x'))).rejects as Record<string, (x: unknown) => Promise<void>>).toThrow('x');
  });
  it('equals handles cycles', () => {
    const a: Record<string, unknown> = { n: 1 }; a.self = a;
    const b: Record<string, unknown> = { n: 1 }; b.self = b;
    vexpect(equals(a, b)).toBe(true);
  });
});
