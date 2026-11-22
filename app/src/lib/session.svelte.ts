// In-memory app state. This is the only place user code lives unless "Remember" is on.
import type { LangChoice, SourceFile, Workspace, SkippedFile } from './types';
import { loadSettings, saveSettings, applyTheme, type Settings } from './settings';
import { clearSession, loadSession, saveSession } from './retention';
import type { Analysis, Role } from '../analysis/model';
import { analyze, pyodideCached, stop as stopWorker } from '../analysis/client';
import { runTests as runSandbox, stopTests, type Progress, type RunOutcome } from '../sandbox/client';
import { detectTests } from '../sandbox/detect-tests';

export type Tab = 'input' | 'queue' | 'code' | 'tests' | 'report';

export const app = $state({
  settings: loadSettings() as Settings,
  tab: 'input' as Tab,
  // draft inputs (not yet loaded)
  pasteText: '',
  pasteName: '',
  pasteLang: 'auto' as LangChoice,
  testsText: '',
  diffText: '',
  specText: '',
  pending: [] as SourceFile[],      // uploaded files waiting to be loaded
  pendingSkipped: [] as SkippedFile[],
  workspace: null as Workspace | null,
  notice: '' as string,
  // analysis (derived from the workspace; never persisted)
  analysis: null as Analysis | null,
  analysisStatus: 'idle' as 'idle' | 'running' | 'needs-consent' | 'done' | 'error',
  analysisMsg: '',
  pythonSkipped: false,
  pyConsent: false,          // this session only
  codeFile: null as string | null,
  selectedLine: null as number | null,
  showHelp: false,
  roleFilter: [] as Role[],  // calm by default: no role tinted until the reviewer asks
  collapsed: {} as Record<string, boolean>,
  wrap: typeof window !== 'undefined' ? window.innerWidth < 760 : true,
  // test runs (Phase 3; memory only, never persisted)
  testStatus: 'idle' as 'idle' | 'needs-consent' | 'running' | 'done',
  testProgress: null as Progress | null,
  testRun: null as RunOutcome | null,
  showCoverage: true,
  // Phase 4: reading passes and queue (memory only; spec links live on the workspace)
  codePass: 'lines' as 'lines' | 'shape' | 'flow' | 'intent',
  selectedFn: null as string | null,
  openBreakdown: null as string | null,
  queueChangedOnly: false,
  specItem: null as string | null,
});

/** Opens a function in the Code tab at its first line. */
export function openFunction(path: string, line: number, fnId?: string): void {
  app.codeFile = path; app.selectedLine = line; app.showHelp = false;
  if (fnId) app.selectedFn = fnId;
  if (app.codePass === 'shape' || app.codePass === 'intent') app.codePass = 'lines';
  app.tab = 'code';
  setTimeout(() => document.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' }), 50);
}

export function toggleSpecLink(item: string, kind: 'function' | 'test', ref: string, how: 'manual' | 'confirmed suggestion' = 'manual'): void {
  const ws = app.workspace;
  if (!ws) return;
  const links = ws.specLinks ?? [];
  const i = links.findIndex((l) => l.item === item && l.kind === kind && l.ref === ref);
  ws.specLinks = i >= 0 ? links.filter((_, j) => j !== i) : [...links, { item, kind, ref, how }];
  void persist();
}

/** Starts a test run. Python needs the one-time Python download (same consent as analysis). */
export async function runTests(opts: { allowPython?: boolean } = {}): Promise<void> {
  const ws = app.workspace;
  if (!ws || app.testStatus === 'running') return;
  const found = detectTests(ws.files);
  const hasPy = found.some((d) => d.lang === 'python');
  let allowPython = !!opts.allowPython || app.pyConsent;
  if (hasPy && !allowPython && (await pyodideCached())) allowPython = true;
  if (hasPy && !allowPython && opts.allowPython === undefined) { app.testStatus = 'needs-consent'; return; }
  if (allowPython) app.pyConsent = true;
  app.testStatus = 'running';
  app.testRun = null;
  app.testProgress = { lang: null, status: 'Starting…', current: null, total: 0, finished: 0 };
  const langs: ('python' | 'javascript')[] = allowPython ? ['python', 'javascript'] : ['javascript'];
  try {
    const r = await runSandbox($state.snapshot(ws.files) as typeof ws.files, {
      testMs: app.settings.testTimeoutSec * 1000, runMs: app.settings.runTimeoutSec * 1000,
    }, (p) => { if (app.workspace === ws) app.testProgress = p; }, langs);
    if (app.workspace !== ws) return; // cleared or replaced meanwhile
    if (hasPy && !allowPython) r.notes.unshift('Python tests were not run: Python support was not downloaded.');
    app.testRun = r;
    app.showCoverage = true;
  } finally {
    if (app.workspace === ws) { app.testStatus = 'done'; app.testProgress = null; }
  }
}

export function stopTestRun(): void { stopTests(); }

export function resetTests(): void {
  stopTests();
  app.testStatus = 'idle'; app.testProgress = null; app.testRun = null; app.showCoverage = true;
}

export async function runAnalysis(): Promise<void> {
  const ws = app.workspace;
  if (!ws) return;
  const hasPy = ws.files.some((f) => f.lang === 'python');
  if (hasPy && !app.pyConsent && !(await pyodideCached())) {
    app.analysisStatus = 'needs-consent';
    return;
  }
  await doAnalyze(hasPy);
}

/** allowPython=false analyzes the JavaScript files only and lists the Python ones as skipped. */
export async function doAnalyze(allowPython: boolean): Promise<void> {
  const ws = app.workspace;
  if (!ws) return;
  if (allowPython) app.pyConsent = true;
  app.analysisStatus = 'running';
  app.analysisMsg = 'Analyzing…';
  try {
    const r = await analyze($state.snapshot(ws.files) as typeof ws.files, allowPython, (m) => (app.analysisMsg = m));
    if (app.workspace !== ws) return; // cleared or replaced meanwhile
    app.analysis = r.analysis;
    app.pythonSkipped = r.pythonSkipped;
    app.analysisStatus = 'done';
    app.analysisMsg = '';
    app.collapsed = {};
    app.selectedLine = null;
    if (!app.codeFile || !r.analysis.files.some((f) => f.path === app.codeFile)) {
      const first = ws.files.find((f) => !f.isTest) ?? ws.files[0];
      app.codeFile = r.analysis.files.find((f) => f.path === first?.path)?.path ?? r.analysis.files[0]?.path ?? null;
    }
  } catch (e) {
    app.analysisStatus = 'error';
    app.analysisMsg = (e as Error).message;
  }
}

function resetAnalysis(): void {
  stopWorker();
  resetTests();
  app.codePass = 'lines'; app.selectedFn = null; app.openBreakdown = null; app.queueChangedOnly = false; app.specItem = null;
  app.analysis = null; app.analysisStatus = 'idle'; app.analysisMsg = ''; app.pythonSkipped = false;
  app.codeFile = null; app.selectedLine = null; app.collapsed = {};
}

export function setSettings(patch: Partial<Settings>): void {
  app.settings = { ...app.settings, ...patch };
  saveSettings(app.settings);
  if (patch.theme) applyTheme(app.settings.theme);
}

export async function setRemember(on: boolean): Promise<void> {
  setSettings({ remember: on });
  if (on) await saveSession(snapshot());
  else await clearSession();
}

/** Called after anything the user would expect to get back changes. No-op unless opted in. */
export async function persist(): Promise<void> {
  if (app.settings.remember) await saveSession(snapshot());
}

function snapshot(): Workspace | null {
  return app.workspace ? $state.snapshot(app.workspace) as Workspace : null;
}

export async function restoreIfRemembered(): Promise<void> {
  if (!app.settings.remember) { await clearSession(); return; } // belt and braces: never leave stale data
  const ws = await loadSession();
  if (ws) { app.workspace = ws; app.notice = 'Restored your remembered session on this device.'; void runAnalysis(); }
}

/** "Clear everything": wipes memory and storage, turns Remember off. Theme is kept. */
export async function clearEverything(): Promise<void> {
  app.pasteText = ''; app.pasteName = ''; app.pasteLang = 'auto';
  app.testsText = ''; app.diffText = ''; app.specText = '';
  app.pending = []; app.pendingSkipped = [];
  app.workspace = null;
  resetAnalysis();
  app.pyConsent = false;
  setSettings({ remember: false });
  await clearSession();
  try { sessionStorage.clear(); } catch { /* ignore */ }
  app.tab = 'input';
  app.notice = 'Cleared. Nothing from this session is left on this device.';
}
