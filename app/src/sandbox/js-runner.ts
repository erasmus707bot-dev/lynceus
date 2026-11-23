// JavaScript test runner for the sandbox worker (brief §6.3).
// - ES modules are converted to CommonJS (Babel, line numbers kept) so `import` works between uploaded files.
// - Source files are instrumented with istanbul; counters are reset before each test, so every
//   covered line knows exactly which tests ran it.
// - describe/it/test + hooks + a Jest-style expect. Unsupported things fail ONE test with a reason.
// Runs only inside the sandbox worker (or Node unit tests). Never on the page.
import './shims/process'; // must come first: Babel reads `process` while loading
import { createInstrumenter } from 'istanbul-lib-instrument';
import { transformSync } from '@babel/core';
// @ts-expect-error: the plugin ships no types
import cjsPluginMod from '@babel/plugin-transform-modules-commonjs';
// @ts-expect-error: the plugin ships no types
import tsPluginMod from '@babel/plugin-transform-typescript';
import { isTsPath, moduleCandidates } from '../analysis/ts';
import { makeExpect, jestStub, UnsupportedError, fmt } from './expect';
import { MISSING_PKG_NOTE, type FileCoverage, type RunInput, type TestInfo, type TestResult, type WorkerEvent } from './protocol';

// The plugin is CommonJS; depending on the bundler its function arrives as the module or as .default.
const cjsPlugin = (cjsPluginMod as { default?: unknown }).default ?? cjsPluginMod;
const tsPlugin = (tsPluginMod as { default?: unknown }).default ?? tsPluginMod;

const TEST_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const NODE_BUILTINS = new Set(['assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'fs/promises',
  'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks', 'process', 'readline', 'stream', 'timers', 'tls', 'tty', 'url', 'util',
  'v8', 'vm', 'worker_threads', 'zlib', 'test']);

const norm = (p: string) => { const out: string[] = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return '/' + out.join('/'); };
const dirname = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const tail = (s: string, n = 2000) => (s.length > n ? '…' + s.slice(-n) : s);

/** True when the source uses import/export syntax (checked cheaply; Babel decides for real). */
const looksESM = (src: string) => /^\s*(import\s*[\w{*'"]|export\s)/m.test(src);

/** ESM → CommonJS, and for TypeScript files types stripped first (line numbers kept, so coverage maps to the source). */
export function toCommonJS(src: string, filename: string): string {
  const ts = isTsPath(filename);
  if (!ts && !looksESM(src)) return src;
  const plugins: unknown[] = [];
  if (ts) plugins.push([tsPlugin, { isTSX: /\.tsx$/i.test(filename), allowDeclareFields: true, onlyRemoveTypeImports: false }]);
  if (looksESM(src)) plugins.push([cjsPlugin, { loose: true }]);
  const out = transformSync(src, {
    filename, babelrc: false, configFile: false, sourceType: 'unambiguous', retainLines: true, compact: false,
    plugins, ast: false, code: true,
  });
  return out?.code ?? src;
}

interface TestCase { kind: 'test'; name: string; fn?: (done?: unknown) => unknown; skip: boolean; todo: boolean; file: string }
interface Suite { kind: 'suite'; name: string; skip: boolean; children: (Suite | TestCase)[]; beforeAll: Fn[]; afterAll: Fn[]; beforeEach: Fn[]; afterEach: Fn[]; file: string }
type Fn = (done?: unknown) => unknown;

class Unsupported extends UnsupportedError {}

function callMaybeDone(fn: Fn): Promise<unknown> {
  if (fn.length > 0) {
    return new Promise((resolve, reject) => {
      const done = (err?: unknown) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(undefined));
      (done as unknown as { fail: (e: unknown) => void }).fail = (e: unknown) => reject(e instanceof Error ? e : new Error(String(e)));
      try { const r = fn(done); if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(() => undefined, reject); }
      catch (e) { reject(e); }
    });
  }
  try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return `thrown value: ${fmt(err)}`;
}

function isOOM(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /out of memory|allocation failed|Invalid array length|Array buffer allocation/i.test(m);
}

export interface JsRunOptions {
  /** Called after setup and instrumentation, right before any user code runs (the worker locks the network here). */
  beforeUserCode?: () => void;
}

const GLOBALS = ['describe', 'xdescribe', 'fdescribe', 'test', 'it', 'xit', 'xtest', 'fit', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach', 'expect', 'jest', 'console', '__lynceus_cov__'];

export async function runJs(input: RunInput, emit: (ev: WorkerEvent) => void, opts: JsRunOptions = {}): Promise<void> {
  // The worker is thrown away after a run; restoring globals matters only when tests call this in Node.
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  try { await runJsInner(input, emit, opts); }
  finally { for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; } }
}

async function runJsInner(input: RunInput, emit: (ev: WorkerEvent) => void, opts: JsRunOptions): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  const notes: string[] = [];
  const files = new Map(input.files.map((f) => [norm(f.path), f.text]));
  const testFiles = new Set(input.testFiles.map(norm));
  const skip = new Set(input.skip);

  // ---- prepare: ESM → CJS, then instrument everything that isn't a pure test file ----
  emit({ type: 'status', msg: 'Preparing JavaScript…' });
  const inst = createInstrumenter({
    coverageVariable: '__lynceus_cov__', esModules: false, compact: false, produceSourceMap: false,
    coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false, // avoid istanbul's `new Function("return this")`
  });
  const code = new Map<string, string>();
  const prepError = new Map<string, string>();
  const statementLines: Record<string, number[]> = {};
  for (const [p, src] of files) {
    if (!/\.[cm]?[jt]sx?$/.test(p) && !p.endsWith('.json')) continue;
    if (/\.d\.ts$/i.test(p)) continue; // declaration files hold types only
    if (p.endsWith('.json')) { code.set(p, src); continue; }
    try {
      const cjs = toCommonJS(src, p);
      if (TEST_PATTERN.test(p)) { code.set(p, cjs); continue; }
      code.set(p, inst.instrumentSync(cjs, p));
      const fc = inst.lastFileCoverage() as { statementMap: Record<string, { start: { line: number } }> };
      statementLines[p] = [...new Set(Object.values(fc.statementMap).map((s) => s.start.line))].sort((a, b) => a - b);
    } catch (e) {
      prepError.set(p, `syntax error: ${errText(e)}`);
    }
  }

  // ---- in-memory module loader ----
  const cache = new Map<string, { exports: unknown }>();
  const resolve = (from: string, spec: string): string => {
    const bare = spec.replace(/^node:/, '');
    if (spec.startsWith('node:') || NODE_BUILTINS.has(bare)) throw new Unsupported(`Node built-in "${spec}" isn't available in Lynceus's browser sandbox.`);
    if (!spec.startsWith('.') && !spec.startsWith('/')) throw new Unsupported(`Package "${spec}" isn't available. Lynceus runs only your uploaded files. ${MISSING_PKG_NOTE}`);
    const base = norm(spec.startsWith('/') ? spec : dirname(from) + '/' + spec);
    for (const c of moduleCandidates(base)) if (code.has(c) || prepError.has(c)) return c;
    throw new Error(`Cannot find module "${spec}" (required from ${from.slice(1)})`);
  };
  const requireFrom = (from: string) => (spec: string): unknown => {
    const p = resolve(from, spec);
    if (prepError.has(p)) throw new Error(`${p.slice(1)} has a ${prepError.get(p)}`);
    const hit = cache.get(p);
    if (hit) return hit.exports;
    const module = { exports: {} as unknown };
    cache.set(p, module);
    if (p.endsWith('.json')) { module.exports = JSON.parse(code.get(p)!); return module.exports; }
    try {
      new Function('module', 'exports', 'require', '__filename', '__dirname', code.get(p)! + `\n//# sourceURL=lynceus:${p}`)(
        module, module.exports, requireFrom(p), p, dirname(p));
    } catch (e) { cache.delete(p); throw e; }
    return module.exports;
  };

  // ---- Jest-style globals ----
  const root: Suite = { kind: 'suite', name: '', skip: false, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [], file: '' };
  let current = root;
  let loadingFile = '';
  let usedOnly = false;
  const addTest = (name: unknown, fn: unknown, flags: { skip?: boolean; todo?: boolean } = {}) => {
    current.children.push({ kind: 'test', name: String(name), fn: typeof fn === 'function' ? fn as Fn : undefined, skip: !!flags.skip, todo: !!flags.todo, file: loadingFile });
  };
  const describe = (name: unknown, fn: unknown, skipIt = false) => {
    const s: Suite = { kind: 'suite', name: String(name), skip: skipIt || current.skip, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [], file: loadingFile };
    current.children.push(s);
    const prev = current; current = s;
    try { if (typeof fn === 'function') (fn as () => void)(); } finally { current = prev; }
  };
  const unsupportedEach = () => { throw new Unsupported('.each() tables are not supported by Lynceus in v1.'); };
  const testFn = Object.assign((n: unknown, f: unknown) => addTest(n, f), {
    skip: (n: unknown, f: unknown) => addTest(n, f, { skip: true }),
    only: (n: unknown, f: unknown) => { usedOnly = true; addTest(n, f); },
    todo: (n: unknown) => addTest(n, undefined, { todo: true }),
    each: unsupportedEach,
  });
  const describeFn = Object.assign((n: unknown, f: unknown) => describe(n, f), {
    skip: (n: unknown, f: unknown) => describe(n, f, true),
    only: (n: unknown, f: unknown) => { usedOnly = true; describe(n, f); },
    each: unsupportedEach,
  });
  const logs: string[] = [];
  const capture = (level: string) => (...a: unknown[]) => { logs.push((level ? level + ': ' : '') + a.map((x) => (typeof x === 'string' ? x : fmt(x))).join(' ')); };
  const fakeConsole = { log: capture(''), info: capture(''), debug: capture(''), warn: capture('warn'), error: capture('error'), trace: capture('trace'), table: capture(''), dir: capture(''), group: capture(''), groupEnd: () => {}, assert: (c: unknown, ...a: unknown[]) => { if (!c) capture('assert')(...a); } };
  Object.assign(g, {
    describe: describeFn, xdescribe: describeFn.skip, fdescribe: describeFn.only,
    test: testFn, it: testFn, xit: testFn.skip, xtest: testFn.skip, fit: testFn.only,
    beforeAll: (f: Fn) => current.beforeAll.push(f), afterAll: (f: Fn) => current.afterAll.push(f),
    beforeEach: (f: Fn) => current.beforeEach.push(f), afterEach: (f: Fn) => current.afterEach.push(f),
    expect: makeExpect(), jest: jestStub,
  });
  g.console = fakeConsole;

  // ---- coverage helpers ----
  const cov = () => (g.__lynceus_cov__ ?? {}) as Record<string, { s: Record<string, number>; f: Record<string, number>; b: Record<string, number[]>; statementMap: Record<string, { start: { line: number } }> }>;
  const lineHits: Record<string, Record<number, Set<string>>> = {};
  const zero = () => { for (const fc of Object.values(cov())) {
    for (const k in fc.s) fc.s[k] = 0;
    for (const k in fc.f) fc.f[k] = 0;
    for (const k in fc.b) fc.b[k] = fc.b[k].map(() => 0);
  } };
  const snap = (label: string) => {
    for (const [p, fc] of Object.entries(cov())) for (const [id, n] of Object.entries(fc.s)) if (n > 0) {
      const line = fc.statementMap[id].start.line;
      ((lineHits[p] ??= {})[line] ??= new Set()).add(label);
    }
  };

  opts.beforeUserCode?.();

  // ---- load test files (registers tests; module-level code runs here = "run at import") ----
  emit({ type: 'status', msg: 'Loading test files…' });
  const loadFailures: TestResult[] = [];
  for (const p of [...testFiles].sort()) {
    loadingFile = p;
    current = root;
    try { requireFrom('/')(p); }
    catch (e) {
      const why = e instanceof UnsupportedError ? errText(e) : `${isOOM(e) ? 'ran out of memory: ' : ''}${errText(e)}`;
      loadFailures.push({ id: `${p.slice(1)}::(load)`, file: p.slice(1), name: '(could not load test file)', lang: 'javascript', outcome: 'error', message: `Could not load the test file, so none of its tests ran. ${why}` });
    }
  }
  loadingFile = '';
  snap('');

  // ---- flatten with unique ids ----
  interface Planned { info: TestInfo; tc: TestCase; chain: Suite[] }
  const planned: Planned[] = [];
  const seen = new Map<string, number>();
  const walk = (s: Suite, chain: Suite[]) => {
    for (const c of s.children) {
      if (c.kind === 'suite') { walk(c, [...chain, c]); continue; }
      const names = [...chain.map((x) => x.name), c.name];
      let id = `${c.file.slice(1)}::${names.join(' › ')}`;
      const k = seen.get(id) ?? 0; seen.set(id, k + 1);
      if (k) id += ` (${k + 1})`;
      planned.push({ info: { id, file: c.file.slice(1), name: names.join(' › '), lang: 'javascript' }, tc: c, chain });
    }
  };
  walk(root, []);
  emit({ type: 'collected', tests: [...loadFailures.map(({ id, file, name, lang }) => ({ id, file, name, lang })), ...planned.map((x) => x.info)] });
  for (const r of loadFailures) emit({ type: 'result', result: r });
  if (usedOnly) notes.push('.only() was ignored: Lynceus runs every test so coverage is complete.');

  // ---- run ----
  const started = new Set<Suite>();
  const failedBeforeAll = new Map<Suite, string>();
  const remainingIn = (s: Suite) => planned.filter((x) => x.chain.includes(s) && !skip.has(x.info.id)).length;
  const doneIn = new Map<Suite, number>();
  for (const { info, tc, chain } of planned) {
    if (skip.has(info.id)) continue;
    const skipped = tc.skip || tc.todo || chain.some((s) => s.skip);
    emit({ type: 'start', id: info.id });
    logs.length = 0;
    const t0 = performance.now();
    let outcome: TestResult['outcome'] = 'passed', message = '';
    if (skipped) { outcome = 'skipped'; message = tc.todo ? 'Marked todo.' : 'Marked skip in the test code.'; }
    else if (!tc.fn) { outcome = 'error'; message = 'This test has no function to run.'; }
    else {
      zero();
      try {
        for (const s of chain) if (!started.has(s)) {
          started.add(s);
          for (const h of s.beforeAll) { try { await callMaybeDone(h); } catch (e) { failedBeforeAll.set(s, errText(e)); break; } }
        }
        const bad = chain.find((s) => failedBeforeAll.has(s));
        if (bad) throw Object.assign(new Error(`beforeAll hook in "${bad.name}" failed: ${failedBeforeAll.get(bad)}`), { lynceusHook: true });
        for (const s of [root, ...chain]) for (const h of s.beforeEach) await callMaybeDone(h);
        await callMaybeDone(tc.fn);
        for (const s of [root, ...chain].reverse()) for (const h of s.afterEach) await callMaybeDone(h);
      } catch (e) {
        if (e instanceof UnsupportedError) { outcome = 'error'; message = errText(e); }
        else if ((e as { lynceusHook?: boolean })?.lynceusHook) { outcome = 'error'; message = errText(e); }
        else if (isOOM(e)) { outcome = 'error'; message = `Ran out of memory: ${errText(e)}`; }
        else { outcome = 'failed'; message = errText(e); }
      }
      snap(info.id);
    }
    // afterAll once the last test of a suite has run
    for (const s of chain) {
      doneIn.set(s, (doneIn.get(s) ?? 0) + 1);
      if (doneIn.get(s) === remainingIn(s) && started.has(s)) for (const h of s.afterAll) { try { await callMaybeDone(h); } catch (e) { notes.push(`afterAll in "${s.name}" failed: ${errText(e)}`); } }
    }
    emit({ type: 'result', result: { ...info, outcome, message, output: logs.length ? tail(logs.join('\n')) : undefined, ms: Math.round(performance.now() - t0) } });
  }

  // ---- coverage per file ----
  const coverage: Record<string, FileCoverage> = {};
  for (const [p, stmts] of Object.entries(statementLines)) {
    const hits = lineHits[p] ?? {};
    coverage[p.slice(1)] = { statements: stmts, lines: Object.fromEntries(Object.entries(hits).map(([l, s]) => [l, [...s].sort()])) };
  }
  emit({ type: 'done', coverage, notes });
}
