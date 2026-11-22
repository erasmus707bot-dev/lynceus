// Turns a FileAnalysis into per-line display data for the code view.
import type { Block, Certainty, FileAnalysis, Role, Statement } from './model';
import { ROLE_ORDER } from './model';

export interface Guide { blockId: string; level: number; warn: boolean; color: number }
export interface LineInfo {
  n: number;                // 1-based line number
  text: string;
  role: Role | null;        // null: blank/comment/continuation with no statement
  certainty: Certainty | null;
  starts: boolean;          // a statement starts on this line (gets the gutter letter)
  statements: Statement[];  // statements whose own text covers this line
  guides: Guide[];          // enclosing blocks, outermost first
  blocks: Block[];          // blocks whose header starts on this line (collapsible)
  flagged: Block | null;    // deepest over-limit block starting here
}

export function buildLines(text: string, fa: FileAnalysis | null, nestingLimit: number): LineInfo[] {
  const raw = text.split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  const lines: LineInfo[] = raw.map((t, i) => ({ n: i + 1, text: t, role: null, certainty: null, starts: false, statements: [], guides: [], blocks: [], flagged: null }));
  if (!fa || !fa.ok) return lines;
  const at = (n: number) => lines[n - 1];
  for (const s of fa.statements) {
    const end = Math.max(s.span.line, Math.min(s.headerEnd, s.span.endLine));
    for (let n = s.span.line; n <= end; n++) at(n)?.statements.push(s);
    const first = at(s.span.line);
    if (first) first.starts = true;
  }
  for (const l of lines) {
    if (!l.statements.length) continue;
    for (const r of ROLE_ORDER) {
      const hits = l.statements.filter((s) => s.role === r);
      if (!hits.length) continue;
      l.role = r;
      l.certainty = r === 'pure' ? (hits.every((s) => s.certainty === 'certain') ? 'certain' : 'heuristic') : (hits.some((s) => s.certainty === 'certain') ? 'certain' : 'heuristic');
      break;
    }
  }
  const blocks = [...fa.blocks].sort((a, b) => a.span.line - b.span.line || b.span.endLine - a.span.endLine);
  blocks.forEach((b, i) => {
    const warn = b.level > nestingLimit;
    for (let n = b.headerEnd + 1; n <= b.span.endLine; n++) at(n)?.guides.push({ blockId: b.id, level: b.level, warn, color: i % 4 });
    const h = at(b.span.line);
    if (h) {
      h.blocks.push(b);
      if (warn && (!h.flagged || b.level > h.flagged.level)) h.flagged = b;
    }
  });
  // keep guides ordered outermost first
  for (const l of lines) l.guides.sort((a, b) => fa.blocks.findIndex((x) => x.id === a.blockId) - fa.blocks.findIndex((x) => x.id === b.blockId));
  return lines;
}

/** Lines hidden by collapsed blocks. */
export function hiddenLines(fa: FileAnalysis | null, collapsed: Record<string, boolean>): Set<number> {
  const hidden = new Set<number>();
  if (!fa) return hidden;
  for (const b of fa.blocks) if (collapsed[b.id]) for (let n = b.headerEnd + 1; n <= b.span.endLine; n++) hidden.add(n);
  return hidden;
}
