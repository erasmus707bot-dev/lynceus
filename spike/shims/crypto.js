// Minimal createHash('sha1') shim for istanbul's file hash (non-security use).
export function createHash() {
  let s = '';
  return { update(x) { s += String(x); return this; }, digest() {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619); h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519); }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  } };
}
export default { createHash };
