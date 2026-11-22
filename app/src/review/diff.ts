// Unified diff parsing (brief §6.4 "in the diff", acceptance #11 "mismatched hunks are reported").
// A hunk only counts when its context and added lines match the loaded code exactly; anything
// else is reported as mismatched instead of being guessed onto the wrong lines.

export interface DiffProblem { file: string; hunk?: string; reason: string }
export interface DiffResult {
  supplied: boolean;
  changed: Record<string, number[]>;  // loaded file path -> changed line numbers (new side)
  problems: DiffProblem[];
  hunks: number;                      // hunks that matched
}

interface Hunk { header: string; newStart: number; lines: string[] }
interface FileDiff { oldPath: string; newPath: string; hunks: Hunk[] }

const stripPrefix = (p: string) => p.replace(/^"|"$/g, '').replace(/^[ab]\//, '').replace(/\t.*$/, '');

export function parseUnified(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      cur = { oldPath: stripPrefix(l.slice(4)), newPath: stripPrefix(lines[i + 1].slice(4)), hunks: [] };
      files.push(cur); hunk = null; i++;
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && cur) { hunk = { header: l.replace(/^(@@[^@]*@@).*$/, '$1'), newStart: Number(m[1]), lines: [] }; cur.hunks.push(hunk); continue; }
    if (hunk && (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-') || l === '')) {
      if (l === '' && i === lines.length - 1) continue;
      hunk.lines.push(l === '' ? ' ' : l);
    } else if (l.startsWith('\\')) continue; // "\ No newline at end of file"
    else if (!l.startsWith('diff ') && !l.startsWith('index ') && !/^(new|deleted) file mode|^similarity|^rename /.test(l)) hunk = null;
  }
  return files;
}

/** Finds the loaded file a diff path refers to: exact match, else a unique suffix match. */
function findFile(p: string, paths: string[]): string | null {
  if (paths.includes(p)) return p;
  const hits = paths.filter((x) => x.endsWith('/' + p) || p.endsWith('/' + x));
  return hits.length === 1 ? hits[0] : null;
}

export function applyDiff(diffText: string, files: { path: string; text: string }[]): DiffResult {
  const out: DiffResult = { supplied: !!diffText.trim(), changed: {}, problems: [], hunks: 0 };
  if (!out.supplied) return out;
  const parsed = parseUnified(diffText);
  if (!parsed.length) { out.problems.push({ file: '(diff)', reason: 'No unified-diff file headers (--- / +++) were found, so the diff was not used.' }); return out; }
  const paths = files.map((f) => f.path);
  for (const fd of parsed) {
    if (fd.newPath === '/dev/null') { out.problems.push({ file: fd.oldPath, reason: 'The diff deletes this file, so there is nothing loaded to mark.' }); continue; }
    const path = findFile(fd.newPath, paths);
    if (!path) { out.problems.push({ file: fd.newPath, reason: 'The diff changes this file, but it is not in the loaded code.' }); continue; }
    const src = files.find((f) => f.path === path)!.text.replace(/\r\n/g, '\n').split('\n');
    const changed = new Set<number>(out.changed[path] ?? []);
    for (const h of fd.hunks) {
      let n = h.newStart;
      const hunkChanged: number[] = [];
      let bad: string | null = null;
      for (const l of h.lines) {
        const tag = l[0], body = l.slice(1);
        if (tag === '-') { hunkChanged.push(Math.max(1, n)); continue; } // a deletion touches the line now at that spot
        if ((src[n - 1] ?? null) !== body) { bad = `line ${n} of the loaded file doesn't match the diff (expected ${JSON.stringify(body.slice(0, 60))})`; break; }
        if (tag === '+') hunkChanged.push(n);
        n++;
      }
      if (bad) { out.problems.push({ file: path, hunk: h.header, reason: `Hunk doesn't match the loaded code: ${bad}. Its lines were not marked.` }); continue; }
      out.hunks++;
      for (const x of hunkChanged) changed.add(Math.min(x, src.length));
    }
    out.changed[path] = [...changed].sort((a, b) => a - b);
  }
  return out;
}
