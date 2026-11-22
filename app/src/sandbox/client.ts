// Page-side test runner: starts a disposable sandbox worker per language and watches it.
// - Per-test limit: if a test doesn't finish in time, the worker is terminated, the test is
//   reported by name as "timeout", and the remaining tests run again in a fresh worker.
// - Per-run limit: counts only time spent running tests (not loading Python).
// - A crashed worker (often out of memory) is handled the same way, with outcome "crashed".
import workerURL from '../workers/sandbox.worker.ts?worker&url';
import type { SourceFile, Lang } from '../lib/types';
import { detectTests } from './detect-tests';
import type { FileCoverage, RunInput, TestInfo, TestResult, WorkerEvent } from './protocol';

export interface RunLimits { testMs: number; runMs: number; loadMs?: number }

export interface Progress {
  lang: Lang | null;
  status: string;
  current: string | null;     // id of the running test
  total: number;
  finished: number;
}

export interface RunOutcome {
  tests: TestInfo[];                         // in collection order
  results: Record<string, TestResult>;
  coverage: Record<string, FileCoverage>;
  notes: string[];
  langs: Lang[];
  stopped: boolean;
}

const MAX_RESTARTS = 8;

function spawn(): Worker {
  // Phase 0 finding: only a blob: worker inherits the page's <meta> CSP.
  const abs = new URL(workerURL, location.href).href;
  const blob = new Blob([`import ${JSON.stringify(abs)};`], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url, { type: 'module' });
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return w;
}

let active: { stop: () => void } | null = null;

export function stopTests(): void { active?.stop(); }

const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`;

export async function runTests(files: SourceFile[], limits: RunLimits, onProgress: (p: Progress) => void, langsAllowed: Lang[]): Promise<RunOutcome> {
  const detected = detectTests(files);
  const out: RunOutcome = { tests: [], results: {}, coverage: {}, notes: [], langs: [], stopped: false };
  let stopRequested = false;
  let killCurrent: (() => void) | null = null;
  active = { stop: () => { stopRequested = true; killCurrent?.(); } };
  const pyodideURL = new URL(import.meta.env.BASE_URL + 'vendor/pyodide/', location.href).href;

  try {
    for (const lang of ['python', 'javascript'] as Lang[]) {
      const testFiles = detected.filter((d) => d.lang === lang).map((d) => d.path);
      if (!testFiles.length || !langsAllowed.includes(lang) || stopRequested) continue;
      out.langs.push(lang);
      const langFiles = files.filter((f) => f.lang === lang || (lang === 'javascript' && f.path.endsWith('.json')));
      const input: RunInput = { lang, files: langFiles.map((f) => ({ path: f.path, text: f.text })), testFiles, skip: [], pyodideURL };
      let budget = limits.runMs;
      let restarts = 0;
      const known = new Map<string, TestInfo>();

      // One pass = one worker. Repeats only after a timeout or crash, skipping the tests that caused it.
      for (;;) {
        const pass = await new Promise<{ end: 'done' | 'timeout' | 'crash' | 'run-limit' | 'fatal' | 'stopped'; id?: string; msg?: string; ranMs: number; coverage?: Record<string, FileCoverage>; notes?: string[] }>((resolve) => {
          const w = spawn();
          let testTimer: ReturnType<typeof setTimeout> | undefined;
          let runTimer: ReturnType<typeof setTimeout> | undefined;
          let loadTimer: ReturnType<typeof setTimeout> | undefined;
          let runStart = 0;
          let current: string | null = null;
          let settled = false;
          const finished = () => Object.values(out.results).filter((r) => known.has(r.id)).length;
          const progress = (status: string) => onProgress({ lang, status, current, total: known.size, finished: finished() });
          const end = (r: Parameters<typeof resolve>[0]) => {
            if (settled) return;
            settled = true;
            clearTimeout(testTimer); clearTimeout(runTimer); clearTimeout(loadTimer);
            w.terminate();
            killCurrent = null;
            resolve(r);
          };
          const ranMs = () => (runStart ? performance.now() - runStart : 0);
          killCurrent = () => end({ end: 'stopped', id: current ?? undefined, ranMs: ranMs() });
          loadTimer = setTimeout(() => end({ end: 'fatal', msg: `Setting up the ${lang === 'python' ? 'Python' : 'JavaScript'} sandbox took longer than ${secs(limits.loadMs ?? 120000)}.`, ranMs: 0 }), limits.loadMs ?? 120000);
          w.onmessage = (e: MessageEvent<WorkerEvent>) => {
            const ev = e.data;
            if (!ev || typeof ev !== 'object') return;
            switch (ev.type) {
              case 'status': progress(ev.msg); break;
              case 'collected':
                for (const t of ev.tests) if (!known.has(t.id)) { known.set(t.id, t); }
                if (!runStart) {
                  clearTimeout(loadTimer);
                  runStart = performance.now();
                  runTimer = setTimeout(() => end({ end: 'run-limit', id: current ?? undefined, ranMs: ranMs() }), Math.max(0, budget));
                }
                progress('Running tests…');
                break;
              case 'start':
                current = ev.id;
                clearTimeout(testTimer);
                testTimer = setTimeout(() => end({ end: 'timeout', id: ev.id, ranMs: ranMs() }), limits.testMs);
                progress('Running tests…');
                break;
              case 'result':
                if (!known.has(ev.result.id)) known.set(ev.result.id, ev.result);
                out.results[ev.result.id] = { ...ev.result, lang };
                if (ev.result.id === current) { clearTimeout(testTimer); current = null; }
                progress('Running tests…');
                break;
              case 'done': end({ end: 'done', coverage: ev.coverage, notes: ev.notes, ranMs: ranMs() }); break;
              case 'fatal': end({ end: 'fatal', msg: ev.msg, id: current ?? undefined, ranMs: ranMs() }); break;
            }
          };
          w.onerror = (e) => { e.preventDefault?.(); end({ end: 'crash', id: current ?? undefined, msg: e.message, ranMs: ranMs() }); };
          w.onmessageerror = () => end({ end: 'crash', id: current ?? undefined, msg: 'message could not be read', ranMs: ranMs() });
          progress(lang === 'python' ? 'Starting Python…' : 'Starting JavaScript…');
          w.postMessage(input);
        });

        budget -= pass.ranMs;
        const info = (id: string): TestInfo => known.get(id) ?? { id, file: id.split('::')[0], name: id.split('::').slice(1).join(' › ') || id, lang };
        if (pass.end === 'done') {
          Object.assign(out.coverage, pass.coverage);
          out.notes.push(...(pass.notes ?? []));
          break;
        }
        if (pass.end === 'timeout' && pass.id) {
          out.results[pass.id] = { ...info(pass.id), outcome: 'timeout', message: `Stopped after ${secs(limits.testMs)}: this test didn't finish (an infinite loop or a promise that never settles?). The sandbox was restarted and the other tests ran again without it.` };
        } else if (pass.end === 'crash') {
          const why = pass.msg ? ` (${pass.msg})` : '';
          if (pass.id) out.results[pass.id] = { ...info(pass.id), outcome: 'crashed', message: `The sandbox crashed while running this test${why}. The usual cause is running out of memory. The other tests ran again without it.` };
          else { out.notes.push(`The ${lang} sandbox crashed before any test started${why}.`); markRest(out, known, lang, `Not run: the sandbox crashed${why}.`); break; }
        } else if (pass.end === 'run-limit') {
          if (pass.id) out.results[pass.id] = { ...info(pass.id), outcome: 'timeout', message: `Stopped when the whole run hit its ${secs(limits.runMs)} limit.` };
          markRest(out, known, lang, `Not run: the whole run hit its ${secs(limits.runMs)} limit first.`);
          out.notes.push(`The ${lang === 'python' ? 'Python' : 'JavaScript'} run hit its ${secs(limits.runMs)} limit. Coverage for it is incomplete.`);
          break;
        } else if (pass.end === 'stopped') {
          out.stopped = true;
          markRest(out, known, lang, 'Not run: you stopped the run.');
          break;
        } else if (pass.end === 'fatal') {
          if (pass.id) out.results[pass.id] = { ...info(pass.id), outcome: 'crashed', message: pass.msg ?? 'The sandbox failed.' };
          out.notes.push(`${lang === 'python' ? 'Python' : 'JavaScript'} tests could not finish: ${pass.msg}`);
          markRest(out, known, lang, `Not run: ${pass.msg}`);
          if (!known.size) for (const f of testFiles) out.results[`${f}::(load)`] = { id: `${f}::(load)`, file: f, name: '(could not run)', lang, outcome: 'error', message: pass.msg ?? 'The sandbox failed.' };
          break;
        }
        if (pass.id) input.skip.push(pass.id);
        if (++restarts > MAX_RESTARTS) {
          markRest(out, known, lang, `Not run: the sandbox had to restart more than ${MAX_RESTARTS} times.`);
          out.notes.push(`Gave up on ${lang} after ${MAX_RESTARTS} restarts.`);
          break;
        }
        if (budget <= 0) {
          markRest(out, known, lang, `Not run: the whole run hit its ${secs(limits.runMs)} limit first.`);
          break;
        }
        // The rerun reports these again; keep only the results of the tests that won't run again.
        for (const id of known.keys()) if (!input.skip.includes(id)) delete out.results[id];
        onProgress({ lang, status: 'Restarting the sandbox and running the remaining tests…', current: null, total: known.size, finished: 0 });
      }
      for (const t of known.values()) if (!out.tests.some((x) => x.id === t.id)) out.tests.push(t);
      for (const f of testFiles) for (const r of Object.values(out.results)) if (r.file === f && !out.tests.some((x) => x.id === r.id)) out.tests.push(r);
    }
  } finally {
    active = null;
  }
  return out;
}

/** Every collected test without a result gets an explicit "not run" reason: never skip silently. */
function markRest(out: RunOutcome, known: Map<string, TestInfo>, lang: Lang, why: string) {
  for (const t of known.values()) if (!out.results[t.id]) out.results[t.id] = { ...t, lang, outcome: 'skipped', message: why };
}
