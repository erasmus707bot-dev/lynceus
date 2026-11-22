// Settings and theme are the ONLY things always saved (localStorage). Never code.
import { DEFAULT_WEIGHTS, validWeights, type Weights } from '../review/risk';
export interface Settings {
  theme: 'light' | 'dark';
  warnLines: number;
  maxLines: number;
  maxFiles: number;
  remember: boolean; // "Remember this session on this device" (opt-in)
  nestingLimit: number; // blocks nested deeper than this get flagged
  testTimeoutSec: number; // per-test limit in the sandbox (brief §5)
  runTimeoutSec: number;  // per-run limit
  riskWeights: Weights;   // brief §6.4 weights (percent), editable on the Queue tab
}

export const DEFAULTS: Settings = { theme: 'light', warnLines: 5000, maxLines: 30000, maxFiles: 200, remember: false, nestingLimit: 3, testTimeoutSec: 10, runTimeoutSec: 60, riskWeights: { ...DEFAULT_WEIGHTS } };
const KEY = 'lynceus.settings';

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadSettings(): Settings {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return { ...DEFAULTS, riskWeights: { ...DEFAULT_WEIGHTS } };
    const p = JSON.parse(raw);
    const s = { ...DEFAULTS };
    if (p.theme === 'dark' || p.theme === 'light') s.theme = p.theme;
    for (const k of ['warnLines', 'maxLines', 'maxFiles', 'nestingLimit', 'testTimeoutSec', 'runTimeoutSec'] as const) if (Number.isFinite(p[k]) && p[k] > 0) s[k] = Math.floor(p[k]);
    s.remember = p.remember === true;
    s.riskWeights = validWeights(p.riskWeights) ?? { ...DEFAULT_WEIGHTS };
    return s;
  } catch { return { ...DEFAULTS, riskWeights: { ...DEFAULT_WEIGHTS } }; }
}

export function saveSettings(s: Settings): void {
  // Whitelist the fields so nothing else can ever end up in localStorage by accident.
  const clean: Settings = { theme: s.theme, warnLines: s.warnLines, maxLines: s.maxLines, maxFiles: s.maxFiles, remember: s.remember, nestingLimit: s.nestingLimit,
    testTimeoutSec: s.testTimeoutSec, runTimeoutSec: s.runTimeoutSec, riskWeights: validWeights(s.riskWeights) ?? { ...DEFAULT_WEIGHTS } };
  try { storage()?.setItem(KEY, JSON.stringify(clean)); } catch { /* private mode: settings just won't stick */ }
}

export function applyTheme(theme: Settings['theme']): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1520' : '#f5f2ec');
}
