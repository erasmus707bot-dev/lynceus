// Page-side handle on the analysis worker.
import workerURL from '../workers/analysis.worker.ts?worker&url';
import type { Analysis } from './model';
import type { SourceFile } from '../lib/types';

export const PYODIDE_CACHE = 'lynceus-pyodide-' + __PYODIDE_VERSION__;
export const PYODIDE_BYTES: number = __PYODIDE_BYTES__;

let worker: Worker | null = null;
let seq = 0;

/** Phase 0 finding: a worker loaded by URL ignores the page's <meta> CSP; one created from a blob: URL inherits it. */
function spawn(): Worker {
  const abs = new URL(workerURL, location.href).href;
  const blob = new Blob([`import ${JSON.stringify(abs)};`], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}

export interface AnalyzeResult { analysis: Analysis; pythonSkipped: boolean }

export function analyze(files: SourceFile[], allowPython: boolean, onProgress?: (msg: string) => void): Promise<AnalyzeResult> {
  if (!worker) worker = spawn();
  const w = worker;
  const id = ++seq;
  const pyodideURL = new URL(import.meta.env.BASE_URL + 'vendor/pyodide/', location.href).href;
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      if (e.data.progress) { onProgress?.(e.data.progress); return; }
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve({ analysis: e.data.result, pythonSkipped: e.data.pythonSkipped });
    };
    const onErr = (e: ErrorEvent) => { w.removeEventListener('message', onMsg); reject(new Error(e.message || 'analysis worker failed')); stop(); };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, files: JSON.parse(JSON.stringify(files)), pyodideURL, allowPython });
  });
}

export function stop(): void { worker?.terminate(); worker = null; }

/** True once the service worker has stored Pyodide (after the first Python review). */
export async function pyodideCached(): Promise<boolean> {
  try {
    if (!('caches' in self)) return false;
    const c = await caches.open(PYODIDE_CACHE);
    return !!(await c.match(new URL(import.meta.env.BASE_URL + 'vendor/pyodide/pyodide.asm.wasm', location.href).href));
  } catch { return false; }
}
