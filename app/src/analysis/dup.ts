// Normalized syntax-tree hash for duplicate detection (brief §6.7): two runs of statements hash the same
// when they have the same shape, with names renamed in order of first use and constants blanked.
// The Python analyzer does the same in analyze.py (dup_hash); both use FNV-1a over the serialized shape.

export const MIN_DUP_NODES = 25; // ignore tiny runs (six one-line assignments are rarely worth a finding)

export interface NodeParts<N> { type: string; name?: string; literal?: boolean; props: string[]; kids: N[] }

export function normalizedHash<N>(nodes: N[], parts: (n: N) => NodeParts<N>): string | null {
  const names = new Map<string, number>();
  let count = 0;
  const out: string[] = [];
  const walk = (n: N) => {
    count++;
    const p = parts(n);
    let tok = p.type;
    if (p.name !== undefined) { if (!names.has(p.name)) names.set(p.name, names.size); tok += '#' + names.get(p.name); }
    if (p.props.length) tok += '[' + p.props.join(',') + ']';
    out.push(tok, '(');
    if (!p.literal) for (const k of p.kids) walk(k);
    out.push(')');
  };
  for (const n of nodes) walk(n);
  if (count < MIN_DUP_NODES) return null;
  return fnv1a(out.join(''));
}

export function fnv1a(s: string): string {
  // 2 x 32-bit FNV-1a with different offsets, so collisions are practically impossible for this use.
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
