// Spec bullets and manual links (brief §6.5 Intent). Only links Scott makes or confirms count.
// Keyword suggestions are labelled heuristic and never count until confirmed.

export interface SpecItem { id: string; text: string; line: number }
export interface SpecLink { item: string; kind: 'function' | 'test'; ref: string; how: 'manual' | 'confirmed suggestion' }
export interface Suggestion { item: string; kind: 'function' | 'test'; ref: string; label: string; shared: string[] }

export function parseSpec(text: string): SpecItem[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const bullet = /^\s*(?:[-*•+]|\d+[.)]|\[[ xX]\])\s+(.*\S)\s*$/;
  const hasBullets = lines.some((l) => bullet.test(l));
  const items: SpecItem[] = [];
  lines.forEach((l, i) => {
    const m = bullet.exec(l);
    const t = m ? m[1] : !hasBullets && l.trim() && !/^#/.test(l.trim()) ? l.trim() : null;
    if (t) items.push({ id: `spec:${i + 1}`, text: t.replace(/^\[[ xX]\]\s*/, ''), line: i + 1 });
  });
  return items;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'must', 'should', 'shall', 'will',
  'have', 'has', 'are', 'not', 'can', 'any', 'all', 'each', 'every', 'only', 'also', 'its', 'their', 'there', 'which', 'user', 'users',
  'test', 'tests', 'function', 'return', 'returns', 'value', 'values', 'data', 'make', 'sure', 'does', 'get', 'set']);

/** Lower-case word stems: splits camelCase and snake_case, drops short and common words, trims plural "s". */
export function words(s: string): string[] {
  const parts = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  const out = new Set<string>();
  for (let w of parts) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return [...out];
}

export function suggest(items: SpecItem[], targets: { kind: 'function' | 'test'; ref: string; label: string }[], links: SpecLink[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const it of items) {
    const iw = new Set(words(it.text));
    for (const t of targets) {
      if (links.some((l) => l.item === it.id && l.kind === t.kind && l.ref === t.ref)) continue;
      const shared = words(t.label).filter((w) => iw.has(w));
      if (shared.length) out.push({ item: it.id, kind: t.kind, ref: t.ref, label: t.label, shared });
    }
  }
  return out;
}
