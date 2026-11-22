// Pattern matching for the editable rule lists in /rules/*.json.
// Pattern forms: "name" (exact), "a.b" (exact dotted), "a.*" (a itself or anything under a),
// "pandas.read_*" (prefix match on the last segment).
export function matches(name: string, pattern: string): boolean {
  if (pattern.endsWith('.*')) {
    const base = pattern.slice(0, -2);
    return name === base || name.startsWith(base + '.');
  }
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}
export function matchAny(name: string, patterns: readonly string[] | undefined): string | null {
  for (const p of patterns ?? []) if (matches(name, p)) return p;
  return null;
}
