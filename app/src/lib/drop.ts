// Drag-and-drop: turn a DataTransfer (files, several files, or whole folders) into named files.
// Folders are walked with the File System Entries API so their structure is preserved.
export interface Named { path: string; file: File }

interface FsEntry { isFile: boolean; isDirectory: boolean; name: string; fullPath: string }
interface FsFileEntry extends FsEntry { file(ok: (f: File) => void, err: (e: unknown) => void): void }
interface FsDirEntry extends FsEntry { createReader(): { readEntries(ok: (es: FsEntry[]) => void, err: (e: unknown) => void): void } }

const MAX_ENTRIES = 5000; // guard against dropping a home folder

async function walk(entry: FsEntry, out: Named[]): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  if (entry.isFile) {
    const f = await new Promise<File>((ok, err) => (entry as FsFileEntry).file(ok, err));
    out.push({ path: entry.fullPath.replace(/^\//, ''), file: f });
  } else if (entry.isDirectory) {
    const reader = (entry as FsDirEntry).createReader();
    // readEntries returns batches; keep reading until empty
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<Named[]> {
  const out: Named[] = [];
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  if (entries.length && entries.every((e) => e)) {
    for (const e of entries) await walk(e!, out);
  } else {
    for (const f of Array.from(dt.files)) out.push({ path: f.name, file: f });
  }
  return out;
}

export const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
