import type { Lang } from './types';

// TypeScript is reviewed by the JavaScript adapter (src/analysis/ts.ts), so .ts files are lang 'javascript'.
const EXT: Record<string, Lang> = { py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', mts: 'javascript', cts: 'javascript' };

export function langFromPath(path: string): Lang | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? EXT[m[1].toLowerCase()] ?? null : null;
}

/** Content-based guess for pasted code. Heuristic: callers must label it as such. */
export function guessLang(text: string): { lang: Lang; confident: boolean } {
  let py = 0, js = 0;
  const t = text.slice(0, 20000);
  const count = (re: RegExp) => (t.match(re) || []).length;
  py += 3 * count(/^\s*def \w+\s*\(.*\)\s*(->.*)?:\s*$/gm);
  py += 2 * count(/^\s*(from \w[\w.]* import |import \w[\w.]*(\s+as \w+)?\s*$)/gm);
  py += 2 * count(/^\s*(elif |except\b|class \w+(\(.*\))?:\s*$)/gm);
  py += count(/\b(self|None|True|False)\b/g) > 0 ? 2 : 0;
  py += count(/^\s*(if|for|while|with|try)\b.*:\s*(#.*)?$/gm);
  js += 3 * count(/\bfunction\s*\w*\s*\(/g);
  js += 2 * count(/\b(const|let|var)\s+\w+\s*=/g);
  js += 2 * count(/=>/g);
  js += 2 * count(/\b(require\(|module\.exports|export (default|const|function)|import .* from ['"])/g);
  js += count(/\b(null|undefined|console\.)\b/g) > 0 ? 2 : 0;
  js += count(/[{};]\s*$/gm) > 2 ? 2 : 0;
  const lang: Lang = py >= js ? 'python' : 'javascript';
  return { lang, confident: Math.abs(py - js) >= 3 };
}

export function isTestPath(path: string, lang: Lang): boolean {
  const base = path.split('/').pop() ?? path;
  if (lang === 'python') return /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py';
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || path.split('/').includes('__tests__');
}

export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}
