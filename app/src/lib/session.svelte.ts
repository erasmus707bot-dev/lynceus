// In-memory app state. This is the only place user code lives unless "Remember" is on.
import type { LangChoice, SourceFile, Workspace, SkippedFile } from './types';
import { loadSettings, saveSettings, applyTheme, type Settings } from './settings';
import { clearSession, loadSession, saveSession } from './retention';

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
});

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
  if (ws) { app.workspace = ws; app.notice = 'Restored your remembered session on this device.'; }
}

/** "Clear everything": wipes memory and storage, turns Remember off. Theme is kept. */
export async function clearEverything(): Promise<void> {
  app.pasteText = ''; app.pasteName = ''; app.pasteLang = 'auto';
  app.testsText = ''; app.diffText = ''; app.specText = '';
  app.pending = []; app.pendingSkipped = [];
  app.workspace = null;
  setSettings({ remember: false });
  await clearSession();
  try { sessionStorage.clear(); } catch { /* ignore */ }
  app.tab = 'input';
  app.notice = 'Cleared. Nothing from this session is left on this device.';
}
