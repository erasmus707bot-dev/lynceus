// Finds which uploaded files hold tests (brief §6.3), before anything runs.
// The runners are the authority on what actually runs; this decides which files to hand them
// and lets the Tests tab say "no tests found" honestly.
import type { Lang, SourceFile } from '../lib/types';

export interface TestFileInfo { path: string; lang: Lang; count: number; inline: boolean }

const PY_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
const PY_FN = /^\s*(?:async\s+)?def\s+test\w*\s*\(/gm;
const JS_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const JS_CALL = /^\s*(?:test|it|xit|xtest|fit)(?:\.(?:only|skip|todo))?\s*\(\s*['"`]/gm;

export function detectTests(files: Pick<SourceFile, 'path' | 'text' | 'lang'>[]): TestFileInfo[] {
  const out: TestFileInfo[] = [];
  for (const f of files) {
    if (f.lang === 'python') {
      if (/(^|\/)conftest\.py$/.test(f.path)) continue;
      const count = (f.text.match(PY_FN) ?? []).length;
      if (count) out.push({ path: f.path, lang: 'python', count, inline: !PY_FILE.test(f.path) });
    } else {
      const count = (f.text.match(JS_CALL) ?? []).length;
      if (count) out.push({ path: f.path, lang: 'javascript', count, inline: !JS_FILE.test(f.path) && !f.path.split('/').includes('__tests__') });
    }
  }
  return out;
}
