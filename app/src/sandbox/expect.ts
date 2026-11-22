// A small Jest-style `expect` for the JS sandbox (brief §6.3). Covers the common matchers.
// Anything else fails that one test with a clear "not supported" reason instead of passing silently.
// Behaviour is pinned by tests/fixtures/expect-snapshots.json.

export class UnsupportedError extends Error {
  constructor(msg: string) { super(msg); this.name = 'UnsupportedError'; }
}

// ---------- formatting ----------
export function fmt(v: unknown, depth = 0, seen: Set<unknown> = new Set()): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (seen.has(v)) return '[Circular]';
  if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
  seen.add(v);
  try {
    if (v instanceof Error) return `[${v.name}: ${v.message}]`;
    if (v instanceof Date) return `Date(${isNaN(+v) ? 'Invalid' : v.toISOString()})`;
    if (v instanceof RegExp) return String(v);
    if (v instanceof Map) return `Map {${[...v].map(([k, x]) => `${fmt(k, depth + 1, seen)} => ${fmt(x, depth + 1, seen)}`).join(', ')}}`;
    if (v instanceof Set) return `Set {${[...v].map((x) => fmt(x, depth + 1, seen)).join(', ')}}`;
    if (Array.isArray(v)) return `[${v.map((x) => fmt(x, depth + 1, seen)).join(', ')}]`;
    const o = v as Record<string, unknown>;
    const name = Object.getPrototypeOf(o)?.constructor?.name;
    const body = Object.keys(o).map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${fmt(o[k], depth + 1, seen)}`).join(', ');
    return `${name && name !== 'Object' ? name + ' ' : ''}{${body}}`;
  } finally { seen.delete(v); }
}

// ---------- equality ----------
/** Jest semantics: toEqual ignores undefined properties and class types; toStrictEqual does not. */
export function equals(a: unknown, b: unknown, strict = false, seen: [unknown, unknown][] = []): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  for (const [x, y] of seen) if (x === a && y === b) return true;
  seen = [...seen, [a, b]];
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && +a === +b;
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  if (a instanceof Error || b instanceof Error) return a instanceof Error && b instanceof Error && a.message === b.message && a.name === b.name;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k), strict, seen)) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v) && ![...b].some((w) => equals(v, w, strict, seen))) return false;
    return true;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  if (Array.isArray(a) && strict && (a as unknown[]).length !== (b as unknown[]).length) return false;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => strict || o[k] !== undefined);
  const ak = keys(ao), bk = keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k) && !(!strict && bo[k] === undefined && ao[k] === undefined)) return false;
    if (!equals(ao[k], bo[k], strict, seen)) return false;
  }
  return true;
}

// ---------- matchers ----------
type Check = (ok: boolean, msg: () => string) => void;

function pathGet(obj: unknown, path: string | (string | number)[]): { found: boolean; value: unknown } {
  const parts = Array.isArray(path) ? path : path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || !(String(p) in Object(cur))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[p as string];
  }
  return { found: true, value: cur };
}

function throwsMatch(err: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (typeof expected === 'string') return msg.includes(expected);
  if (expected instanceof RegExp) return expected.test(msg);
  if (typeof expected === 'function') return err instanceof (expected as new () => unknown);
  if (expected instanceof Error) return msg === expected.message;
  return false;
}

function build(actual: unknown, negated: boolean, label: string): Record<string, (...a: unknown[]) => void> {
  const not = negated ? '.not' : '';
  const check: Check = (ok, msg) => { if (ok === negated) throw new Error(msg()); };
  const head = (m: string, arg = 'expected') => `expect(${label})${not}.${m}(${arg})`;
  const num = (m: string, n: unknown) => {
    if (typeof actual !== 'number' && typeof actual !== 'bigint') throw new Error(`${head(m)}\n\nReceived value must be a number. Received: ${fmt(actual)}`);
    if (typeof n !== 'number' && typeof n !== 'bigint') throw new Error(`${head(m)}\n\nExpected value must be a number. Expected: ${fmt(n)}`);
  };
  const m: Record<string, (...a: unknown[]) => void> = {
    toBe: (e) => check(Object.is(actual, e), () => `${head('toBe')}\n\nExpected: ${negated ? 'not ' : ''}${fmt(e)}\nReceived: ${fmt(actual)}` +
      (!negated && equals(actual, e) ? '\n\nThe values are equal but not the same object. Use toEqual to compare contents.' : '')),
    toEqual: (e) => check(equals(actual, e), () => `${head('toEqual')}\n\nExpected: ${negated ? 'not ' : ''}${fmt(e)}\nReceived: ${fmt(actual)}`),
    toStrictEqual: (e) => check(equals(actual, e, true), () => `${head('toStrictEqual')}\n\nExpected: ${negated ? 'not ' : ''}${fmt(e)}\nReceived: ${fmt(actual)}`),
    toBeTruthy: () => check(!!actual, () => `${head('toBeTruthy', '')}\n\nReceived: ${fmt(actual)}`),
    toBeFalsy: () => check(!actual, () => `${head('toBeFalsy', '')}\n\nReceived: ${fmt(actual)}`),
    toBeNull: () => check(actual === null, () => `${head('toBeNull', '')}\n\nReceived: ${fmt(actual)}`),
    toBeUndefined: () => check(actual === undefined, () => `${head('toBeUndefined', '')}\n\nReceived: ${fmt(actual)}`),
    toBeDefined: () => check(actual !== undefined, () => `${head('toBeDefined', '')}\n\nReceived: ${fmt(actual)}`),
    toBeNaN: () => check(typeof actual === 'number' && Number.isNaN(actual), () => `${head('toBeNaN', '')}\n\nReceived: ${fmt(actual)}`),
    toBeInstanceOf: (c) => check(typeof c === 'function' && actual instanceof (c as new () => unknown), () => `${head('toBeInstanceOf')}\n\nExpected constructor: ${(c as { name?: string })?.name ?? fmt(c)}\nReceived: ${fmt(actual)}`),
    toBeGreaterThan: (n) => { num('toBeGreaterThan', n); check((actual as number) > (n as number), () => `${head('toBeGreaterThan')}\n\nExpected: ${negated ? 'not ' : ''}> ${fmt(n)}\nReceived:   ${fmt(actual)}`); },
    toBeGreaterThanOrEqual: (n) => { num('toBeGreaterThanOrEqual', n); check((actual as number) >= (n as number), () => `${head('toBeGreaterThanOrEqual')}\n\nExpected: ${negated ? 'not ' : ''}>= ${fmt(n)}\nReceived:    ${fmt(actual)}`); },
    toBeLessThan: (n) => { num('toBeLessThan', n); check((actual as number) < (n as number), () => `${head('toBeLessThan')}\n\nExpected: ${negated ? 'not ' : ''}< ${fmt(n)}\nReceived:   ${fmt(actual)}`); },
    toBeLessThanOrEqual: (n) => { num('toBeLessThanOrEqual', n); check((actual as number) <= (n as number), () => `${head('toBeLessThanOrEqual')}\n\nExpected: ${negated ? 'not ' : ''}<= ${fmt(n)}\nReceived:    ${fmt(actual)}`); },
    toBeCloseTo: (n, digits = 2) => {
      num('toBeCloseTo', n);
      const ok = Math.abs((n as number) - (actual as number)) < Math.pow(10, -(digits as number)) / 2;
      check(ok, () => `${head('toBeCloseTo', 'expected, precision')}\n\nExpected: ${negated ? 'not ' : ''}${fmt(n)} (to ${digits} digits)\nReceived: ${fmt(actual)}`);
    },
    toContain: (e) => {
      if (typeof actual !== 'string' && !(actual && typeof (actual as Iterable<unknown>)[Symbol.iterator] === 'function'))
        throw new Error(`${head('toContain')}\n\nReceived value must be a string, array or other iterable. Received: ${fmt(actual)}`);
      const ok = typeof actual === 'string' ? actual.includes(String(e)) : [...(actual as Iterable<unknown>)].some((x) => Object.is(x, e) || x === e);
      check(ok, () => `${head('toContain')}\n\nExpected item: ${negated ? 'not ' : ''}${fmt(e)}\nReceived: ${fmt(actual)}`);
    },
    toContainEqual: (e) => {
      const ok = !!actual && typeof (actual as Iterable<unknown>)[Symbol.iterator] === 'function' && [...(actual as Iterable<unknown>)].some((x) => equals(x, e));
      check(ok, () => `${head('toContainEqual')}\n\nExpected item: ${negated ? 'not ' : ''}${fmt(e)}\nReceived: ${fmt(actual)}`);
    },
    toHaveLength: (n) => {
      const len = (actual as { length?: unknown })?.length;
      if (typeof len !== 'number') throw new Error(`${head('toHaveLength')}\n\nReceived value has no length property. Received: ${fmt(actual)}`);
      check(len === n, () => `${head('toHaveLength')}\n\nExpected length: ${negated ? 'not ' : ''}${fmt(n)}\nReceived length: ${len}\nReceived: ${fmt(actual)}`);
    },
    toHaveProperty: (...args) => {
      const [p, value] = args;
      const r = pathGet(actual, p as string);
      const ok = r.found && (args.length < 2 || equals(r.value, value));
      check(ok, () => `${head('toHaveProperty', 'path' + (args.length > 1 ? ', value' : ''))}\n\nPath: ${fmt(p)}` +
        (args.length > 1 ? `\nExpected value: ${negated ? 'not ' : ''}${fmt(value)}` : '') + `\nReceived: ${r.found ? fmt(r.value) : '(property not found)'}`);
    },
    toMatch: (re) => {
      if (typeof actual !== 'string') throw new Error(`${head('toMatch')}\n\nReceived value must be a string. Received: ${fmt(actual)}`);
      const ok = re instanceof RegExp ? re.test(actual) : actual.includes(String(re));
      check(ok, () => `${head('toMatch')}\n\nExpected pattern: ${negated ? 'not ' : ''}${fmt(re)}\nReceived string: ${fmt(actual)}`);
    },
    toMatchObject: (e) => {
      const sub = (a: unknown, b: unknown): boolean => {
        if (typeof b !== 'object' || b === null || typeof a !== 'object' || a === null) return equals(a, b);
        if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((x, i) => sub(a[i], x));
        return Object.keys(b).every((k) => k in (a as object) && sub((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
      };
      check(sub(actual, e), () => `${head('toMatchObject')}\n\nExpected: ${negated ? 'not ' : ''}${fmt(e)}\nReceived: ${fmt(actual)}`);
    },
    toThrow: (e) => {
      if (typeof actual !== 'function') throw new Error(`${head('toThrow')}\n\nReceived value must be a function. Received: ${fmt(actual)}`);
      let threw = false, err: unknown;
      try { (actual as () => unknown)(); } catch (x) { threw = true; err = x; }
      const ok = threw && throwsMatch(err, e);
      check(ok, () => `${head('toThrow', e === undefined ? '' : 'expected')}\n\n` +
        (e === undefined ? '' : `Expected: ${negated ? 'not ' : ''}${fmt(e)}\n`) +
        (threw ? `Received error: ${fmt(err)}` : 'Received function did not throw'));
    },
  };
  m.toThrowError = m.toThrow;
  return m;
}

const SUPPORTED = 'toBe, toEqual, toStrictEqual, toBeTruthy, toBeFalsy, toBeNull, toBeUndefined, toBeDefined, toBeNaN, toBeInstanceOf, toBeGreaterThan(OrEqual), toBeLessThan(OrEqual), toBeCloseTo, toContain, toContainEqual, toHaveLength, toHaveProperty, toMatch, toMatchObject, toThrow';

function guard<T extends object>(target: T, chain: string): T {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) return (t as Record<string | symbol, unknown>)[k];
      if (k === 'then') return undefined; // so `await expect(x)` doesn't look like a promise
      throw new UnsupportedError(`expect(…)${chain}.${String(k)} is not supported by Lynceus. Supported matchers: ${SUPPORTED}.`);
    },
  });
}

export interface Expect { (actual: unknown): Record<string, unknown>; assertions(n: number): void }

export function makeExpect(): Expect {
  const expect = ((actual: unknown) => {
    const base: Record<string, unknown> = build(actual, false, 'received');
    base.not = guard(build(actual, true, 'received'), '.not');
    const asyncSide = (neg: boolean, kind: 'resolves' | 'rejects') => guard(new Proxy({}, {
      get: (_t, k) => {
        if (typeof k === 'symbol') return undefined;
        const matchers = (v: unknown) => build(v, neg, 'received');
        if (!(k in matchers(undefined))) return undefined; // falls through to guard → unsupported
        return async (...a: unknown[]) => {
          if (!actual || typeof (actual as Promise<unknown>).then !== 'function')
            throw new Error(`expect(received).${kind}.${String(k)}()\n\nReceived value must be a promise. Received: ${fmt(actual)}`);
          if (kind === 'resolves') {
            let v: unknown;
            try { v = await actual; } catch (err) { throw new Error(`expect(received).resolves.${String(k)}()\n\nReceived promise rejected instead of resolved\nRejected to value: ${fmt(err)}`); }
            return matchers(v)[k](...a);
          }
          let err: unknown, rejected = false;
          try { await actual; } catch (x) { rejected = true; err = x; }
          if (!rejected) throw new Error(`expect(received).rejects.${String(k)}()\n\nReceived promise resolved instead of rejected`);
          if (k === 'toThrow' || k === 'toThrowError') return matchers(() => { throw err; })[k](...a);
          return matchers(err)[k](...a);
        };
      },
      has: (_t, k) => typeof k === 'string' && k in build(undefined, false, ''),
    }), `.${kind}`);
    base.resolves = asyncSide(false, 'resolves');
    base.rejects = asyncSide(false, 'rejects');
    return guard(base, '');
  }) as Expect;
  expect.assertions = () => { /* accepted and ignored: Lynceus doesn't count assertions */ };
  return guard(expect as unknown as object, '') as unknown as Expect;
}

/** `jest.*` helpers are not available; any use fails the test with a clear reason. */
export const jestStub = new Proxy({}, {
  get(_t, k) {
    if (typeof k === 'symbol' || k === 'then') return undefined;
    return () => { throw new UnsupportedError(`jest.${String(k)}() is not available in Lynceus (no mocks or fake timers in v1).`); };
  },
});
