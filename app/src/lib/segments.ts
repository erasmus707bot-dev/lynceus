// Splits one source line into plain text, masked secrets and tappable name tokens (lens).
import type { SecretSpan, Ref } from '../analysis/model';
import { maskValue } from '../analysis/secrets';

export interface Tok { col: number; endCol: number; binding: string; access: Ref['access'] }
export type Seg =
  | { kind: 'text'; text: string }
  | { kind: 'secret'; text: string; shown: string; key: string; revealed: boolean; first: boolean }
  | { kind: 'tok'; text: string; binding: string; access: Ref['access'] };

export const secretKey = (path: string, s: SecretSpan) => `${path}:${s.line}:${s.col}`;

/** Column range a secret covers on one line (endCol = Infinity: to the end of the line). */
export function secretRange(s: SecretSpan, line: number): [number, number] | null {
  if (line < s.line || line > s.endLine) return null;
  return [line === s.line ? s.col : 0, line === s.endLine ? s.endCol : Infinity];
}

export function lineSegments(text: string, line: number, path: string, secrets: SecretSpan[], toks: Tok[], revealed: Record<string, boolean>): Seg[] {
  type R = { a: number; b: number; seg: (t: string) => Seg };
  const ranges: R[] = [];
  for (const s of secrets) {
    const r = secretRange(s, line);
    if (!r) continue;
    const key = secretKey(path, s);
    const a = Math.min(r[0], text.length), b = Math.min(r[1], text.length);
    if (b <= a) continue;
    ranges.push({ a, b, seg: (t) => ({ kind: 'secret', text: t, shown: revealed[key] ? t : maskValue(t), key, revealed: !!revealed[key], first: line === s.line }) });
  }
  for (const t of toks) {
    if (t.endCol <= t.col || ranges.some((r) => t.col < r.b && r.a < t.endCol)) continue;
    ranges.push({ a: t.col, b: Math.min(t.endCol, text.length), seg: (x) => ({ kind: 'tok', text: x, binding: t.binding, access: t.access }) });
  }
  if (!ranges.length) return [{ kind: 'text', text }];
  ranges.sort((x, y) => x.a - y.a);
  const out: Seg[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.a < pos) continue;
    if (r.a > pos) out.push({ kind: 'text', text: text.slice(pos, r.a) });
    out.push(r.seg(text.slice(r.a, r.b)));
    pos = r.b;
  }
  if (pos < text.length) out.push({ kind: 'text', text: text.slice(pos) });
  return out;
}

/** Masks every secret in a run of source lines (for report excerpts). Lines are 1-based from `first`. */
export function maskLines(lines: string[], first: number, secrets: SecretSpan[]): string[] {
  return lines.map((text, i) => {
    const n = first + i;
    return lineSegments(text, n, '', secrets, [], {}).map((s) => (s.kind === 'secret' ? maskValue(s.text) : s.text)).join('');
  });
}
