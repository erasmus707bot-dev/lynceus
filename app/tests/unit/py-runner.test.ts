// @vitest-environment node
// Runs the real Python test harness (src/sandbox/py_runner.py) in Pyodide with the self-hosted wheels.
// Needs `npm run vendor` first (it downloads the pinned wheels into public/vendor/pyodide/wheels).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runPython } from '../../src/sandbox/py-host';
import type { RunInput, WorkerEvent, TestResult } from '../../src/sandbox/protocol';

const require = createRequire(import.meta.url);
const WHEELS_DIR = path.resolve(__dirname, '../../public/vendor/pyodide/wheels');
const wheels: string[] = JSON.parse(readFileSync(path.join(WHEELS_DIR, 'manifest.json'), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadPyodide: any;

beforeAll(() => { loadPyodide = require('pyodide').loadPyodide; });

async function run(files: Record<string, string>, testFiles: string[], skip: string[] = [], extra: Partial<RunInput> = {}) {
  const py = await loadPyodide({ indexURL: path.dirname(require.resolve('pyodide/package.json')) + '/' });
  const events: WorkerEvent[] = [];
  const input: RunInput = { lang: 'python', files: Object.entries(files).map(([p, text]) => ({ path: p, text })), testFiles, skip, pyodideURL: '', ...extra };
  await runPython(py, input, (e) => events.push(e), { wheels, readWheel: async (w) => readFileSync(path.join(WHEELS_DIR, w)) });
  const results: Record<string, TestResult> = Object.fromEntries(events.filter((e) => e.type === 'result').map((e) => [(e as { result: TestResult }).result.id, (e as { result: TestResult }).result]));
  const done = events.find((e) => e.type === 'done') as Extract<WorkerEvent, { type: 'done' }>;
  return { events, results, done };
}

const CALC = `def add(a, b):
    return a + b


def sign(n):
    if n < 0:
        return -1
    return 1
`;

describe('Python runner (pytest + per-test coverage in Pyodide)', () => {
  it('runs tests, reports pass/fail with the assertion, and maps lines to tests', async () => {
    const { results, done, events } = await run({
      'calc.py': CALC,
      'test_calc.py': `from calc import add, sign\n\ndef test_add():\n    assert add(1, 2) == 3\n\ndef test_sign():\n    assert sign(5) == 2\n`,
      'unused.py': `def never():\n    return 1\n`,
    }, ['test_calc.py']);
    expect(events.find((e) => e.type === 'collected')).toMatchObject({ tests: [{ id: 'test_calc.py::test_add' }, { id: 'test_calc.py::test_sign' }] });
    expect(results['test_calc.py::test_add'].outcome).toBe('passed');
    expect(results['test_calc.py::test_sign'].outcome).toBe('failed');
    expect(results['test_calc.py::test_sign'].message).toMatch(/assert 1 == 2/);
    const c = done.coverage['calc.py'];
    expect(c.statements).toEqual([1, 2, 5, 6, 7, 8]);
    expect(c.lines['2']).toEqual(['test_calc.py::test_add']);
    expect(c.lines['8']).toEqual(['test_calc.py::test_sign']);
    expect(c.lines['7']).toBeUndefined();  // not run by the provided tests
    expect(c.lines['1']).toEqual(['']);     // def line runs at import
    expect(done.coverage['unused.py'].statements).toEqual([1, 2]); // never imported, still listed
    expect(done.coverage['unused.py'].lines).toEqual({});
  }, 60000);

  it('lists a test file that cannot import a missing package, with the reason', async () => {
    const { results } = await run({ 'test_np.py': `import numpy\n\ndef test_x():\n    assert True\n` }, ['test_np.py']);
    const r = results['test_np.py::(load)'];
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/Missing package 'numpy'\. Package downloads are off/);
  }, 60000);

  it('reports skips, fixture errors, captured output, classes and deselected ids', async () => {
    const { results } = await run({
      'test_misc.py': `import pytest

@pytest.fixture
def broken():
    raise RuntimeError("fixture broke")

def test_skip():
    pytest.skip("not today")

def test_fixture(broken):
    pass

def test_prints():
    print("hello from test")

class TestThing:
    def test_method(self):
        assert [1, 2] == [1, 2]

def test_hangs():
    while True:
        pass
`,
    }, ['test_misc.py'], ['test_misc.py::test_hangs']);
    expect(results['test_misc.py::test_skip']).toMatchObject({ outcome: 'skipped', message: 'not today' });
    expect(results['test_misc.py::test_fixture'].outcome).toBe('error');
    expect(results['test_misc.py::test_fixture'].message).toMatch(/fixture broke/);
    expect(results['test_misc.py::test_prints'].output).toMatch(/hello from test/);
    expect(results['test_misc.py::TestThing::test_method']).toMatchObject({ outcome: 'passed', name: 'TestThing › test_method' });
    expect(results['test_misc.py::test_hangs']).toBeUndefined();
  }, 60000);

  it('runs inline tests in a file with any name, in a subfolder', async () => {
    const { results, done } = await run({
      'pkg/pasted.py': `def inc(x):\n    return x + 1\n\ndef test_inc():\n    assert inc(1) == 2\n`,
    }, ['pkg/pasted.py']);
    expect(results['pkg/pasted.py::test_inc'].outcome).toBe('passed');
    expect(done.coverage['pkg/pasted.py'].lines['2']).toEqual(['pkg/pasted.py::test_inc']);
  }, 60000);

  it('blocks js, pyodide, micropip, socket and urllib from user tests', async () => {
    const { results } = await run({
      'test_exfil.py': `import pytest

def test_js():
    import js

def test_pyodide_http():
    import pyodide.http

def test_micropip():
    import micropip

def test_socket():
    import socket
    socket.create_connection(("example.com", 80))

def test_urllib():
    import urllib.request
    urllib.request.urlopen("http://example.com")
`,
    }, ['test_exfil.py']);
    for (const t of ['js', 'pyodide_http', 'micropip', 'socket', 'urllib']) {
      const r = results[`test_exfil.py::test_${t}`];
      expect(r.outcome, t).toBe('failed');
      expect(r.message, t).toMatch(/network blocked by Lynceus/);
    }
  }, 60000);

  it('packages mode: a downloaded wheel is installed before the tests run, and the missing-package message says how to get more', async () => {
    const tiny = zipSync({ 'tinypkg/__init__.py': strToU8('def triple(x):\n    return 3 * x\n'), 'tinypkg-1.0.dist-info/METADATA': strToU8('Name: tinypkg\nVersion: 1.0\n') });
    const { results } = await run({
      'test_pkg.py': 'import tinypkg\n\ndef test_triple():\n    assert tinypkg.triple(2) == 6\n\ndef test_other():\n    import yaml\n',
    }, ['test_pkg.py'], [], { extraWheels: [{ file: 'tinypkg-1.0-py3-none-any.whl', data: tiny }], packagesMode: true });
    const byName = Object.fromEntries(Object.values(results).map((r) => [r.name, r]));
    expect(byName.test_triple.outcome).toBe('passed');
    expect(byName.test_other.message).toMatch(/Missing package 'yaml'\. Package downloads are on: check the names under "Package downloads"/);
  }, 120000);
});

