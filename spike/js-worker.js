// Sandbox worker for JavaScript: istanbul instrumentation + in-memory CommonJS loader
// + a tiny Jest-style shim, with coverage counters reset per test.
import { createInstrumenter } from './vendor/istanbul.mjs';
import { lockNetwork } from './guard.js';

const norm = (p) => { const out = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return '/' + out.join('/'); };
const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const isTest = (p) => /\.(test|spec)\.[cm]?js$/.test(p);

function makeExpect() {
  const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
  const deepEq = (a, b) => fmt(a) === fmt(b);
  const matchers = (actual, neg = false) => {
    const check = (ok, msg) => { if (ok === neg) throw new Error((neg ? 'not ' : '') + msg); };
    const m = {
      toBe: (e) => check(Object.is(actual, e), `expected ${fmt(actual)} toBe ${fmt(e)}`),
      toEqual: (e) => check(deepEq(actual, e), `expected ${fmt(actual)} toEqual ${fmt(e)}`),
      toBeTruthy: () => check(!!actual, `expected ${fmt(actual)} toBeTruthy`),
      toContain: (e) => check(actual.includes(e), `expected ${fmt(actual)} toContain ${fmt(e)}`),
      toHaveLength: (n) => check(actual.length === n, `expected length ${actual.length} toHaveLength ${n}`),
      toThrow: (e) => {
        let threw = false, msg = '';
        try { actual(); } catch (err) { threw = true; msg = String(err && err.message); }
        check(threw && (e === undefined || msg.includes(e)), `expected function toThrow ${e ?? ''} (got ${threw ? msg : 'no throw'})`);
      },
    };
    return m;
  };
  return (actual) => {
    const m = matchers(actual);
    m.not = matchers(actual, true);
    m.resolves = new Proxy({}, { get: (_, k) => async (...a) => matchers(await actual)[k](...a) });
    m.rejects = new Proxy({}, { get: (_, k) => async (...a) => {
      let err; try { await actual; } catch (x) { err = x; }
      if (err === undefined) throw new Error('expected promise to reject');
      return matchers(() => { throw err; })[k](...a);
    } });
    return m;
  };
}

self.onmessage = async (e) => {
  const { files, noguard } = e.data; // { "/src/calc.js": "...", ... }
  const t0 = performance.now();
  try {
    const inst = createInstrumenter({ coverageVariable: '__coverage__', esModules: false, compact: false,
      // Avoid istanbul's default `new Function("return this")` lookup:
      coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false });
    const code = {};
    const maps = {};
    for (const [p, src] of Object.entries(files)) {
      if (isTest(p)) { code[p] = src; continue; }
      code[p] = inst.instrumentSync(src, p);
      maps[p] = inst.lastFileCoverage();
    }
    const tInstr = performance.now();
    const guardReport = noguard ? ['GUARD DISABLED (test variant)'] : lockNetwork(self);

    // in-memory CommonJS loader
    const cache = {};
    const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'child_process', 'http', 'https', 'net', 'crypto', 'process']);
    const requireFrom = (from) => (spec) => {
      if (NODE_BUILTINS.has(spec.replace(/^node:/, ''))) throw new Error(`Node built-in "${spec}" is not available in Lynceus`);
      let p = norm(dirname(from) + '/' + spec);
      if (!(p in code) && (p + '.js') in code) p += '.js';
      if (!(p in code)) throw new Error(`module not found: ${spec} (from ${from})`);
      if (cache[p]) return cache[p].exports;
      const module = { exports: {} };
      cache[p] = module;
      new Function('module', 'exports', 'require', code[p])(module, module.exports, requireFrom(p));
      return module.exports;
    };

    // Jest-style globals
    const tests = [];
    let prefix = [];
    globalThis.describe = (name, fn) => { prefix.push(name); fn(); prefix.pop(); };
    globalThis.test = globalThis.it = (name, fn) => tests.push({ name: [...prefix, name].join(' > '), fn });
    globalThis.expect = makeExpect();
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };

    const results = [];
    for (const p of Object.keys(code).filter(isTest)) {
      try { cache[p] = undefined; requireFrom('/')(p); }
      catch (err) { results.push({ test: p, outcome: 'error', message: 'could not load test file: ' + err.message }); }
    }
    const zero = () => { for (const fc of Object.values(globalThis.__coverage__ || {})) {
      for (const k of Object.keys(fc.s)) fc.s[k] = 0;
      for (const k of Object.keys(fc.f)) fc.f[k] = 0;
      for (const k of Object.keys(fc.b)) fc.b[k] = fc.b[k].map(() => 0);
    } };
    const perTestLines = {};
    const snap = (label) => {
      for (const [p, fc] of Object.entries(globalThis.__coverage__ || {})) {
        for (const [id, n] of Object.entries(fc.s)) if (n > 0) {
          const line = fc.statementMap[id].start.line;
          ((perTestLines[p] ??= {})[line] ??= new Set()).add(label);
        }
      }
    };
    snap('(module load)'); // lines run while test files were being loaded
    for (const t of tests) {
      zero();
      try { await t.fn(); results.push({ test: t.name, outcome: 'passed' }); }
      catch (err) { results.push({ test: t.name, outcome: 'failed', message: String(err && err.message || err) }); }
      snap(t.name);
    }
    const contexts = {};
    const analysis = {};
    for (const [p, fc] of Object.entries(maps)) {
      const stmtLines = [...new Set(Object.values(fc.statementMap).map((s) => s.start.line))].sort((a, b) => a - b);
      const hit = perTestLines[p] || {};
      contexts[p] = Object.fromEntries(Object.entries(hit).map(([l, s]) => [l, [...s].sort()]));
      analysis[p] = { statements: stmtLines, missing: stmtLines.filter((l) => !hit[l]) };
    }
    self.postMessage({ results, contexts, analysis, guardReport, logs,
      timing: { instrumentMs: Math.round(tInstr - t0), runMs: Math.round(performance.now() - tInstr) } });
  } catch (err) {
    self.postMessage({ fatal: String(err && err.stack || err) });
  }
};
