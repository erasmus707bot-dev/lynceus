// Minimal POSIX `path` for Babel and istanbul in the browser (they only use it for file names).
const norm = (p: string): string => {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const s of p.split('/')) { if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else if (s && s !== '.') out.push(s); }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
};
export const sep = '/';
export const delimiter = ':';
export const normalize = norm;
export const isAbsolute = (p: string) => p.startsWith('/');
export const join = (...parts: string[]) => norm(parts.filter(Boolean).join('/'));
export const resolve = (...parts: string[]) => {
  let r = '';
  for (const p of parts) { if (!p) continue; r = p.startsWith('/') ? p : r + '/' + p; }
  return norm(r.startsWith('/') ? r : '/' + r);
};
export const dirname = (p: string) => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); };
export const basename = (p: string, ext?: string) => { const b = p.replace(/\/+$/, '').split('/').pop() ?? ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
export const extname = (p: string) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export const relative = (from: string, to: string) => {
  const a = resolve(from).split('/').filter(Boolean), b = resolve(to).split('/').filter(Boolean);
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
};
export const parse = (p: string) => { const base = basename(p), ext = extname(p); return { root: p.startsWith('/') ? '/' : '', dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; };
export const format = (o: { dir?: string; base?: string; name?: string; ext?: string }) => join(o.dir ?? '', o.base ?? (o.name ?? '') + (o.ext ?? ''));
const path = { sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative, parse, format };
export const posix = path;
export default path;
