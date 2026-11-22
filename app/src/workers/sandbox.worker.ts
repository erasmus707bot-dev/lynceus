// Sandbox worker: the ONLY place user code runs (brief §5). One worker per run, thrown away afterwards.
// Started from a blob: URL (see sandbox/client.ts) so the page's <meta> CSP applies here too.
// Order matters: load our own code and assets first, then lock the network, then run user code.
import { lockNetwork, takePostMessage } from '../sandbox/guard';
import type { RunInput, WorkerEvent } from '../sandbox/protocol';

const post = takePostMessage(self as unknown as typeof globalThis);
const emit = (ev: WorkerEvent) => post(ev);
const lock = () => {
  const report = lockNetwork(self as unknown as typeof globalThis);
  if (report.length) emit({ type: 'status', msg: 'Network lock warnings: ' + report.join('; ') });
};

function fatal(err: unknown) {
  const m = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  emit({ type: 'fatal', msg: /out of memory|allocation failed|MemoryError/i.test(m) ? `The sandbox ran out of memory. ${m}` : m });
}

self.addEventListener('message', async (e: MessageEvent<RunInput>) => {
  const input = e.data;
  try {
    if (input.lang === 'python') {
      emit({ type: 'status', msg: 'Starting Python…' });
      const mod = await import(/* @vite-ignore */ input.pyodideURL + 'pyodide.mjs');
      const py = await mod.loadPyodide({ indexURL: input.pyodideURL });
      const wheels: string[] = await (await fetch(input.pyodideURL + 'wheels/manifest.json')).json();
      const { runPython } = await import('../sandbox/py-host');
      await runPython(py, input, emit, {
        wheels,
        readWheel: async (w) => new Uint8Array(await (await fetch(input.pyodideURL + 'wheels/' + w)).arrayBuffer()),
        beforeUserCode: lock,
      });
    } else {
      emit({ type: 'status', msg: 'Loading the JavaScript test runner…' });
      const { runJs } = await import('../sandbox/js-runner');
      await runJs(input, emit, { beforeUserCode: lock });
    }
  } catch (err) {
    fatal(err);
  }
}, { once: true });
