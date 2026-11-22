// Drives a loaded Pyodide instance through one Python test run. Shared by the sandbox worker
// and the Node unit tests, so both exercise exactly the same harness.
import GUARD from './py_guard.py?raw';
import RUNNER from './py_runner.py?raw';
import type { RunInput, WorkerEvent } from './protocol';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pyodide = any;

export interface PyHostDeps {
  wheels: string[];                                  // wheel file names (self-hosted)
  readWheel: (name: string) => Promise<Uint8Array>;  // same-origin fetch in the browser, disk in Node
  beforeUserCode?: () => void;                       // the worker locks the JS network here
  guard?: string; runner?: string;                   // Node tests pass the sources (no ?raw there)
}

const PROJ = '/home/pyodide/proj';

export async function installWheels(py: Pyodide, deps: PyHostDeps): Promise<void> {
  const site: string = py.runPython('import site; site.getsitepackages()[0]');
  for (const w of deps.wheels) {
    const buf = await deps.readWheel(w);
    py.FS.writeFile('/tmp/' + w, buf);
    py.runPython(`import zipfile; zipfile.ZipFile(${JSON.stringify('/tmp/' + w)}).extractall(${JSON.stringify(site)})`);
  }
}

export async function runPython(py: Pyodide, input: RunInput, emit: (ev: WorkerEvent) => void, deps: PyHostDeps): Promise<void> {
  emit({ type: 'status', msg: 'Installing pytest and coverage…' });
  await installWheels(py, deps);
  for (const f of input.files) {
    const full = `${PROJ}/${f.path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, f.text);
  }
  const nonce = '\u0001LYN' + Math.random().toString(36).slice(2) + ':';
  let done = false;
  py.setStdout({ batched: () => {} });
  py.setStderr({
    batched: (line: string) => {
      if (!line.startsWith(nonce)) return;
      try {
        const ev = JSON.parse(line.slice(nonce.length)) as WorkerEvent;
        if (ev.type === 'done') done = true;
        emit(ev);
      } catch { /* malformed line: ignore */ }
    },
  });
  py.runPython((deps.guard ?? GUARD) + '\n' + (deps.runner ?? RUNNER));
  py.globals.set('LYNCEUS_CFG', JSON.stringify({ proj: PROJ, nonce, skip: input.skip, testFiles: input.testFiles }));
  emit({ type: 'status', msg: 'Running Python tests…' });
  deps.beforeUserCode?.();
  await py.runPythonAsync('lynceus_run(LYNCEUS_CFG)');
  if (!done) emit({ type: 'fatal', msg: 'The Python test run ended without reporting results.' });
}
