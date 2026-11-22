import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { clearSession, loadSession, saveSession } from '../../src/lib/retention';
import { loadSettings, saveSettings, DEFAULTS } from '../../src/lib/settings';
import type { Workspace } from '../../src/lib/types';

const ws: Workspace = { files: [{ path: 'a.py', text: 'SECRET_CODE = 1', lang: 'python', langSource: 'extension', lines: 1, isTest: false }], skipped: [], diff: '', spec: '', loadedAt: 1 };

describe('IndexedDB session (opt-in)', () => {
  beforeEach(async () => { await clearSession(); localStorage.clear(); });
  it('round-trips', async () => {
    await saveSession(ws);
    expect((await loadSession())?.files[0].text).toBe('SECRET_CODE = 1');
  });
  it('clearSession deletes the database', async () => {
    await saveSession(ws); await clearSession();
    expect(await loadSession()).toBeNull();
    const dbs = await indexedDB.databases();
    expect(dbs.map((d) => d.name)).not.toContain('lynceus-session');
  });
  it('saveSession(null) clears', async () => {
    await saveSession(ws); await saveSession(null);
    expect(await loadSession()).toBeNull();
  });
});

describe('settings (localStorage)', () => {
  beforeEach(() => localStorage.clear());
  it('defaults: light theme, remember off', () => {
    expect(loadSettings()).toEqual(DEFAULTS);
    expect(DEFAULTS.theme).toBe('light'); expect(DEFAULTS.remember).toBe(false);
  });
  it('persists only whitelisted fields, never code', () => {
    saveSettings({ ...DEFAULTS, theme: 'dark', code: 'SECRET_CODE' } as never);
    const raw = localStorage.getItem('lynceus.settings')!;
    expect(raw).not.toContain('SECRET_CODE');
    expect(loadSettings().theme).toBe('dark');
  });
  it('ignores junk', () => {
    localStorage.setItem('lynceus.settings', '{"theme":"neon","maxLines":-5}');
    expect(loadSettings()).toEqual(DEFAULTS);
  });
});
