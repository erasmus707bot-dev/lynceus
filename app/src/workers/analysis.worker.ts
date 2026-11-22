// Analysis worker: parsing, roles, nesting. Never runs the user's code.
// Started from a blob: URL (see analysis/client.ts) so it inherits the page's CSP.
import { JsAnalyzer } from '../analysis/js/adapter';
import PY_SOURCE from '../analysis/python/analyze.py?raw';
import PY_RULES from '../../rules/python.json';
import type { FileAnalysis } from '../analysis/model';
import type { SourceFile } from '../lib/types';

interface Req { id: number; files: SourceFile[]; pyodideURL: string; allowPython: boolean }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pyodide: any = null;

async function getPyodide(url: string) {
  if (pyodide) return pyodide;
  const mod = await import(/* @vite-ignore */ url + 'pyodide.mjs');
  pyodide = await mod.loadPyodide({ indexURL: url });
  pyodide.runPython(PY_SOURCE);
  return pyodide;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, files, pyodideURL, allowPython } = e.data;
  const t0 = performance.now();
  try {
    const js = files.filter((f) => f.lang === 'javascript');
    const py = files.filter((f) => f.lang === 'python');
    const out: FileAnalysis[] = js.length ? new JsAnalyzer().analyze(js) : [];
    let pythonSkipped = false;
    if (py.length) {
      if (!allowPython) pythonSkipped = true;
      else {
        (self as unknown as Worker).postMessage({ id, progress: 'Loading Python (first time only)…' });
        const p = await getPyodide(pyodideURL);
        p.globals.set('LYNCEUS_IN', JSON.stringify({ files: py.map((f) => ({ path: f.path, text: f.text })), rules: PY_RULES }));
        const res: FileAnalysis[] = JSON.parse(p.runPython('analyze_json(LYNCEUS_IN)'));
        // Python adapter numbers files from 0; make ids unique across both languages.
        for (const fa of res) {
          const prefix = `py${files.indexOf(py.find((f) => f.path === fa.path)!)}`;
          const fix = (s: string) => s.replace(/^\d+:/, prefix + ':');
          fa.statements.forEach((s) => { s.id = fix(s.id); if (s.fn) s.fn = fix(s.fn); });
          fa.blocks.forEach((b) => (b.id = fix(b.id)));
          fa.functions.forEach((f) => (f.id = fix(f.id)));
        }
        out.push(...res);
      }
    }
    const order = new Map(files.map((f, i) => [f.path, i]));
    out.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
    (self as unknown as Worker).postMessage({ id, result: { files: out, ms: Math.round(performance.now() - t0) }, pythonSkipped });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
