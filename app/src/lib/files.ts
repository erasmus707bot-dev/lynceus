import { unzipSync, strFromU8 } from 'fflate';
import type { Lang, LangChoice, SkippedFile, SourceFile } from './types';
import { countLines, guessLang, isTestPath, langFromPath } from './detect';
import { isTsPath } from '../analysis/ts';

const IGNORED_DIRS = ['__MACOSX', 'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'];
const MAX_FILE_BYTES = 2_000_000;

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\/+/, '').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
}

export function makeFile(path: string, text: string, choice: LangChoice = 'auto'): SourceFile {
  const p = normalizePath(path);
  let lang: Lang, langSource: SourceFile['langSource'];
  const byExt = langFromPath(p);
  if (choice !== 'auto') { lang = choice === 'typescript' ? 'javascript' : choice; langSource = 'manual'; }
  else if (byExt) { lang = byExt; langSource = 'extension'; }
  else { lang = guessLang(text).lang; langSource = 'content (heuristic)'; }
  return { path: p, text, lang, langSource, lines: countLines(text), isTest: isTestPath(p, lang) };
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Classify one named blob of bytes. Every rejection gets a reason: nothing is dropped silently. */
export function acceptBytes(path: string, bytes: Uint8Array): { file?: SourceFile; skipped?: SkippedFile } {
  const p = normalizePath(path);
  const parts = p.split('/');
  const dir = parts.find((s) => IGNORED_DIRS.includes(s));
  if (dir) return { skipped: { path: p, reason: `inside ignored folder "${dir}"` } };
  if (!langFromPath(p)) return { skipped: { path: p, reason: 'not a Python, JavaScript or TypeScript file (Lynceus reviews .py, .js and .ts)' } };
  if (bytes.length > MAX_FILE_BYTES) return { skipped: { path: p, reason: `file is over ${MAX_FILE_BYTES / 1e6} MB` } };
  if (looksBinary(bytes)) return { skipped: { path: p, reason: 'looks like a binary file' } };
  return { file: makeFile(p, strFromU8(bytes)) };
}

export function readZip(bytes: Uint8Array): { files: SourceFile[]; skipped: SkippedFile[] } {
  const files: SourceFile[] = [], skipped: SkippedFile[] = [];
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); }
  catch (e) { return { files, skipped: [{ path: '(zip)', reason: 'could not read the .zip: ' + (e as Error).message }] }; }
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // folder entry
    const r = acceptBytes(name, data);
    if (r.file) files.push(r.file); else if (r.skipped) skipped.push(r.skipped);
  }
  return { files: stripCommonRoot(files), skipped };
}

/** Zips made by "Compress folder" put everything under one top folder; drop it so imports resolve. */
export function stripCommonRoot(files: SourceFile[]): SourceFile[] {
  if (files.length < 2) return files;
  const first = files[0].path.split('/')[0];
  if (!files.every((f) => f.path.includes('/') && f.path.split('/')[0] === first)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

/** Merge new files in; a later file with the same path replaces the earlier one. */
export function mergeFiles(existing: SourceFile[], incoming: SourceFile[]): SourceFile[] {
  const map = new Map(existing.map((f) => [f.path, f]));
  for (const f of incoming) map.set(f.path, f);
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function pastedName(lang: Lang | 'typescript', kind: 'code' | 'tests'): string {
  if (lang === 'python') return kind === 'tests' ? 'test_pasted.py' : 'pasted.py';
  if (lang === 'typescript') return kind === 'tests' ? 'pasted.test.ts' : 'pasted.ts';
  return kind === 'tests' ? 'pasted.test.js' : 'pasted.js';
}

/** Short label for file lists: Python, JS or TS. */
export const langLabel = (f: Pick<SourceFile, 'lang' | 'path'>) => (f.lang === 'python' ? 'Python' : isTsPath(f.path) ? 'TS' : 'JS');
