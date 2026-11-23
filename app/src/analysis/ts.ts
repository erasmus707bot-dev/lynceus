// TypeScript support (v1.1). TypeScript files are reviewed by the JavaScript adapter: Babel parses the
// types and Lynceus ignores them. Type annotations, interfaces and type aliases never count as code to
// review (no statements, no complexity); `x as T`, `x!` and `x satisfies T` are read as plain `x`.

export const TS_EXT = /\.(ts|tsx|mts|cts)$/i;
export const isTsPath = (path: string) => TS_EXT.test(path) && !/\.d\.ts$/i.test(path);

/**
 * Files an import specifier can mean, in order. TypeScript projects write `import './util.js'` for util.ts,
 * so a .js specifier also tries .ts/.tsx.
 */
export function moduleCandidates(base: string): string[] {
  const out = [base];
  const m = /^(.*)\.(m|c)?js$/.exec(base);
  if (m) out.push(`${m[1]}.${m[2] ?? ''}ts`, `${m[1]}.tsx`);
  for (const e of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json']) out.push(base + e);
  out.push(base + '/index.js', base + '/index.ts', base + '/index.tsx');
  return out;
}

/** Babel parser plugins for a file, by its extension. */
export function parserPlugins(path: string): ('jsx' | 'typescript')[] {
  if (/\.(tsx)$/i.test(path)) return ['typescript', 'jsx'];
  if (TS_EXT.test(path)) return ['typescript'];
  return ['jsx'];
}

/** Heuristic, for pasted code only: TypeScript-only syntax that plain JavaScript can't have. */
export function looksTypeScript(text: string): boolean {
  const t = text.slice(0, 20000);
  return /^\s*(export\s+)?(interface|type)\s+[A-Z]\w*(<[^>]*>)?\s*(=|\{|extends)/m.test(t)
    || /\(\s*\w+\??\s*:\s*(string|number|boolean|any|unknown|void|[A-Z]\w*)(\[\])?\s*[,)=]/.test(t)
    || /\)\s*:\s*(string|number|boolean|void|Promise<[^>]+>|[A-Z]\w*(\[\])?)\s*(\{|=>)/.test(t)
    || /\b(private|public|protected|readonly)\s+\w+\s*:/.test(t)
    || /\bas\s+(const|string|number|any|unknown)\b/.test(t);
}

const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);
const SKIP = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra', 'range',
  'typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters', 'typeArguments']);

type AnyNode = { type: string; [k: string]: unknown };
const isNode = (v: unknown): v is AnyNode => !!v && typeof v === 'object' && typeof (v as AnyNode).type === 'string';

/**
 * Replaces `x as T`, `x!`, `x satisfies T`, `<T>x` and `f<T>` with plain `x` / `f`, in place, so the
 * rest of the JavaScript adapter sees ordinary expressions. Type annotations themselves are left alone
 * (the adapter never walks into them for roles). Returns how many wrappers were removed.
 */
export function unwrapTsExpressions(root: unknown): number {
  let n = 0;
  const strip = (v: AnyNode): AnyNode => { while (WRAPPERS.has(v.type) && isNode(v.expression)) { v = v.expression; n++; } return v; };
  const walk = (node: AnyNode) => {
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c, i) => { if (isNode(c)) { const s = strip(c); v[i] = s; walk(s); } });
      else if (isNode(v)) { const s = strip(v); node[key] = s; walk(s); }
    }
  };
  if (isNode(root)) walk(root);
  return n;
}
