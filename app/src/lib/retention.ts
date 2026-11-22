// Opt-in persistence ("Remember this session on this device"). IndexedDB only, one record.
// Default is OFF: nothing about the user's code is stored anywhere.
import type { Workspace } from './types';

const DB = 'lynceus-session';
const STORE = 'session';
const KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export async function saveSession(ws: Workspace | null): Promise<void> {
  if (!ws) return clearSession();
  await tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(ws)), KEY));
}

async function exists(): Promise<boolean> {
  // Opening a missing database would create an empty one; check first where the browser allows it.
  if (typeof indexedDB.databases !== 'function') return true;
  try { return (await indexedDB.databases()).some((d) => d.name === DB); } catch { return true; }
}

export async function loadSession(): Promise<Workspace | null> {
  try {
    if (!(await exists())) return null;
    return (await tx<Workspace | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  }
  catch { return null; }
}

/** Removes the whole database, not just the record. */
export function clearSession(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
