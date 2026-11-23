// "Share to Lynceus" (Android, installed app only). The phone's share sheet POSTs to ./share; the service
// worker (public/sw.js) puts the shared text and files in the `lynceus-share` cache and opens ./?shared=1.
// This module reads that cache once, deletes it straight away, and removes ?shared from the address bar.
// Nothing is sent anywhere: the share goes from the phone's share sheet to this page and nowhere else.
import { acceptBytes, readZip } from './files';
import type { SkippedFile, SourceFile } from './types';

export const SHARE_CACHE = 'lynceus-share';

export interface SharedMeta { title: string; text: string; url: string; files: { key: string; name: string }[]; dropped: string[] }
export interface SharedInput { title: string; text: string; url: string; files: { name: string; bytes: Uint8Array }[]; dropped: string[] }
export interface ShareResult { pasteText: string; pasteName: string; files: SourceFile[]; skipped: SkippedFile[]; notice: string }

const CODE_NAME = /\.(py|[cm]?jsx?|[cm]?tsx?)$/i;

/** Turns what was shared into Input-tab fields. Pure, so it can be unit tested. */
export function interpretShare(s: SharedInput): ShareResult {
  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = s.dropped.map((path) => ({ path, reason: 'too many or too large to share at once' }));
  for (const f of s.files) {
    if (/\.zip$/i.test(f.name)) { const z = readZip(f.bytes); files.push(...z.files); skipped.push(...z.skipped); continue; }
    const r = acceptBytes(f.name, f.bytes);
    if (r.file) files.push(r.file);
    if (r.skipped) skipped.push(r.skipped);
  }
  const text = s.text.trim();
  const onlyLink = /^https?:\/\/\S+$/.test(text) || (!text && !!s.url);
  const pasteText = onlyLink ? '' : s.text;
  const title = s.title.trim();
  const pasteName = pasteText && CODE_NAME.test(title) && !/[\\/]/.test(title) ? title : '';
  const parts: string[] = [];
  if (files.length) parts.push(`${files.length} shared file${files.length === 1 ? '' : 's'} added below`);
  if (pasteText) parts.push('shared text put in the paste box');
  if (skipped.length) parts.push(`${skipped.length} not included (listed below)`);
  let notice = parts.length ? `From your share: ${parts.join(', ')}. Press "Review this code" when ready.` : 'Nothing usable was shared.';
  if (onlyLink) notice = 'A link was shared. Lynceus never goes online, so it can\'t open links. Share the file itself, or copy the code and share it as text.' + (files.length ? ` ${notice}` : '');
  return { pasteText, pasteName, files, skipped, notice };
}

/** Reads and deletes a pending share, if this page was opened by one. */
export async function takeShared(): Promise<ShareResult | null> {
  if (typeof location === 'undefined') return null;
  const params = new URLSearchParams(location.search);
  const flag = params.get('shared');
  if (!flag) return null;
  params.delete('shared');
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  if (flag === 'error' || typeof caches === 'undefined') return { pasteText: '', pasteName: '', files: [], skipped: [], notice: 'The share could not be read. Try sharing again, or upload the file on the Input tab.' };
  try {
    const cache = await caches.open(SHARE_CACHE);
    const metaRes = await cache.match(new URL('__share/meta', location.href).href);
    if (!metaRes) return null; // already picked up (for example a reload)
    const meta = (await metaRes.json()) as SharedMeta;
    const files: SharedInput['files'] = [];
    for (const f of meta.files) {
      const r = await cache.match(f.key);
      if (r) files.push({ name: f.name, bytes: new Uint8Array(await r.arrayBuffer()) });
    }
    return interpretShare({ ...meta, files });
  } catch (e) {
    return { pasteText: '', pasteName: '', files: [], skipped: [], notice: `The share could not be read (${(e as Error).message}).` };
  } finally {
    try { await caches.delete(SHARE_CACHE); } catch { /* ignore */ }
  }
}

/** Used by "Clear everything". */
export async function clearShared(): Promise<void> {
  try { if (typeof caches !== 'undefined') await caches.delete(SHARE_CACHE); } catch { /* ignore */ }
}
