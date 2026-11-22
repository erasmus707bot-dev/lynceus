// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { runJs } from '../../src/sandbox/js-runner';
import type { RunInput, WorkerEvent, TestResult } from '../../src/sandbox/protocol';

async function run(files: Record<string, string>, testFiles: string[], skip: string[] = []) {
  const events: WorkerEvent[] = [];
  const input: RunInput = { lang: 'javascript', files: Object.entries(files).map(([path, text]) => ({ path, text })), testFiles, skip, pyodideURL: '' };
  await runJs(input, (e) => events.push(e));
  const results = Object.fromEntries(events.filter((e) => e.type === 'result').map((e) => [(e as { result: TestResult }).result.name, (e as { result: TestResult }).result]));
  const done = events.find((e) => e.type === 'done') as Extract<WorkerEvent, { type: 'done' }>;
  return { events, results, done };
}

const CALC = `function add(a, b) { return a + b; }
function sign(n) {
  if (n < 0) {
    return -1;
  }
  return 1;
}
module.exports = { add, sign };
`;

describe('JS runner', () => {
  it('runs CommonJS tests with pass and fail, and per-test coverage', async () => {
    const { results, done } = await run({
      'src/calc.js': CALC,
      'src/calc.test.js': `const { add, sign } = require('./calc');
describe('calc', () => {
  test('adds', () => { expect(add(1, 2)).toBe(3); });
  test('sign positive', () => { expect(sign(5)).toBe(2); });
});`,
    }, ['src/calc.test.js']);
    expect(results['calc › adds'].outcome).toBe('passed');
    expect(results['calc › sign positive'].outcome).toBe('failed');
    expect(results['calc › sign positive'].message).toMatch(/Expected: 2\nReceived: 1/);
    const c = done.coverage['src/calc.js'];
    expect(c.statements).toEqual(expect.arrayContaining([1, 3, 4, 6, 8]));
    expect(c.lines[1]).toEqual(['src/calc.test.js::calc › adds']);
    expect(c.lines[6]).toEqual(['src/calc.test.js::calc › sign positive']);
    expect(c.lines[4]).toBeUndefined(); // the negative branch: not run by the provided tests
    expect(c.lines[8]).toEqual(['']);    // module.exports runs at import
  });

  it('supports ES module import/export between uploaded files', async () => {
    const { results, done } = await run({
      'lib/math.js': `export function double(x) {\n  return x * 2;\n}\nexport default function half(x) { return x / 2; }\n`,
      'lib/math.spec.js': `import half, { double } from './math.js';\nit('doubles', () => expect(double(2)).toBe(4));\nit('halves', () => expect(half(8)).toEqual(4));\n`,
    }, ['lib/math.spec.js']);
    expect(results['doubles'].outcome).toBe('passed');
    expect(results['halves'].outcome).toBe('passed');
    expect(done.coverage['lib/math.js'].lines[2]).toEqual(['lib/math.spec.js::doubles']); // line numbers kept through the ESM transform
  });

  it('fails one test with a clear reason for Node built-ins and packages', async () => {
    const { results } = await run({
      'a.test.js': `test('uses fs', () => { require('fs'); });\ntest('uses lodash', () => { require('lodash'); });\ntest('ok', () => {});`,
    }, ['a.test.js']);
    expect(results['uses fs'].outcome).toBe('error');
    expect(results['uses fs'].message).toMatch(/Node built-in "fs" isn't available/);
    expect(results['uses lodash'].message).toMatch(/Package "lodash" isn't available.*Package downloads are off/);
    expect(results['ok'].outcome).toBe('passed');
  });

  it('lists a test file that cannot load instead of skipping it silently', async () => {
    const { results } = await run({ 'b.test.js': `const x = require('./missing');\ntest('never', () => {});` }, ['b.test.js']);
    expect(results['(could not load test file)'].outcome).toBe('error');
    expect(results['(could not load test file)'].message).toMatch(/Cannot find module "\.\/missing"/);
  });

  it('handles hooks, async, done callbacks, skip, todo and resolves/rejects', async () => {
    const { results } = await run({
      'h.test.js': `let n = 0;
beforeEach(() => { n = 1; });
describe('group', () => {
  beforeAll(() => { n = 100; });
  it('sees beforeEach', () => expect(n).toBe(1));
  it('async', async () => { await new Promise((r) => setTimeout(r, 5)); expect(await Promise.resolve(3)).toBe(3); });
  it('done callback', (done) => { setTimeout(() => { expect(1).toBe(1); done(); }, 5); });
  it.skip('skipped', () => { throw new Error('no'); });
  it.todo('later');
  it('resolves', () => expect(Promise.resolve([1, 2])).resolves.toHaveLength(2));
  it('rejects', () => expect(Promise.reject(new Error('boom'))).rejects.toThrow('boom'));
  it('rejects but resolved', () => expect(Promise.resolve(1)).rejects.toThrow());
});`,
    }, ['h.test.js']);
    expect(results['group › sees beforeEach'].outcome).toBe('passed');
    expect(results['group › async'].outcome).toBe('passed');
    expect(results['group › done callback'].outcome).toBe('passed');
    expect(results['group › skipped'].outcome).toBe('skipped');
    expect(results['group › later'].outcome).toBe('skipped');
    expect(results['group › resolves'].outcome).toBe('passed');
    expect(results['group › rejects'].outcome).toBe('passed');
    expect(results['group › rejects but resolved'].outcome).toBe('failed');
  });

  it('inline tests in a source file: file is both covered and tested', async () => {
    const { results, done } = await run({
      'pasted.js': `function inc(x) {\n  return x + 1;\n}\ntest('inc', () => { expect(inc(1)).toBe(2); });\n`,
    }, ['pasted.js']);
    expect(results['inc'].outcome).toBe('passed');
    expect(done.coverage['pasted.js'].lines[2]).toEqual(['pasted.js::inc']);
  });

  it('skips ids it is told to skip (after a timeout) and captures console output', async () => {
    const { results, events } = await run({
      'c.test.js': `test('hangs', () => { while (true) {} });\ntest('logs', () => { console.log('hello', { a: 1 }); });`,
    }, ['c.test.js'], ['c.test.js::hangs']);
    expect(results['hangs']).toBeUndefined();
    expect(results['logs'].output).toBe('hello {a: 1}');
    expect(events.some((e) => e.type === 'collected' && e.tests.length === 2)).toBe(true);
  });

  it('unsupported matcher and jest.fn fail that test with a reason', async () => {
    const { results } = await run({
      'd.test.js': `test('snap', () => { expect(1).toMatchSnapshot(); });\ntest('mock', () => { jest.fn(); });\ntest('each', () => {});\n`,
    }, ['d.test.js']);
    expect(results['snap'].outcome).toBe('error');
    expect(results['snap'].message).toMatch(/toMatchSnapshot is not supported by Lynceus/);
    expect(results['mock'].message).toMatch(/jest\.fn\(\) is not available/);
  });

  it('restores globals afterwards', async () => {
    await run({ 'e.test.js': `test('x', () => {});` }, ['e.test.js']);
    expect((globalThis as Record<string, unknown>).describe).toBeUndefined();
  });
});
