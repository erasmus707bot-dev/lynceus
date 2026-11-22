// istanbul only uses createHash('sha1') to fingerprint a file's source (not for security).
// A fast non-cryptographic hash is enough for that.
export function createHash() {
  let s = '';
  return {
    update(x: unknown) { s += String(x); return this; },
    digest() {
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619); h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519); }
      return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
    },
  };
}
export default { createHash };
