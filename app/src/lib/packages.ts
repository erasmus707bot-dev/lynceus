// Package downloads (brief §5, decision 6): OFF by default.
//
// How it stays off: the normal page (index.html) has `connect-src 'self'`, so nothing can reach PyPI at all.
// Turning downloads on reopens the app as packages.html, a copy of the same app whose policy also allows
// https://pypi.org and https://files.pythonhosted.org (written at build time by vite.config.ts). Installed
// apps and plain visits always start on the strict page.
//
// What is sent: only package NAMES, and only after the reviewer confirms the list. The fetching is done
// here, by Lynceus's own page code, never by user code: the sandbox worker still locks the network before
// any uploaded code runs. Each wheel's sha256 is checked against the digest PyPI lists for it, and only
// pure-Python wheels (py3-none-any) are used, because compiled packages can't run in Pyodide from PyPI.
import { unzipSync, strFromU8 } from 'fflate';
import type { Workspace } from './types';

export const PYPI = 'https://pypi.org';
export const PYPI_FILES = 'https://files.pythonhosted.org';
export const PACKAGES_PAGE = 'packages.html';

export const packagesMode = (): boolean => typeof location !== 'undefined' && location.pathname.endsWith('/' + PACKAGES_PAGE);

/** Import names that differ from the name on PyPI (the reviewer can still edit the list). */
export const IMPORT_TO_DIST: Record<string, string> = {
  yaml: 'PyYAML', bs4: 'beautifulsoup4', dateutil: 'python-dateutil', dotenv: 'python-dotenv', jwt: 'PyJWT',
  sklearn: 'scikit-learn', PIL: 'Pillow', cv2: 'opencv-python', attr: 'attrs', magic: 'python-magic',
  Crypto: 'pycryptodome', serial: 'pyserial', usb: 'pyusb', git: 'GitPython', jose: 'python-jose', multipart: 'python-multipart',
};

/** Already inside Lynceus's own Python (pytest and its helpers): never fetched. */
export const BUNDLED = new Set(['pytest', 'coverage', 'pluggy', 'iniconfig', 'packaging', 'pygments', '_pytest']);

const MAX_PACKAGES = 30;
const MAX_WHEEL_BYTES = 20_000_000;
const PY = { python_version: '3.14', python_full_version: '3.14.0', sys_platform: 'emscripten', platform_system: 'Emscripten', os_name: 'posix', implementation_name: 'cpython', platform_machine: 'wasm32', platform_python_implementation: 'CPython' } as Record<string, string>;

export const normName = (n: string) => n.trim().toLowerCase().replace(/[-_.]+/g, '-');

/** Package import names from "Missing package 'x'" test messages (Python only). */
export function missingFromMessages(messages: string[]): string[] {
  const out = new Set<string>();
  for (const m of messages) for (const x of m.matchAll(/Missing package '([\w.]+)'/g)) out.add(x[1].split('.')[0]);
  return [...out].filter((n) => !BUNDLED.has(n)).sort();
}

/** The names to offer for download, mapped from import names to PyPI names. */
export const suggestDists = (imports: string[]) => [...new Set(imports.map((i) => IMPORT_TO_DIST[i] ?? i))];

// ---------- environment markers (PEP 508), just enough for Requires-Dist ----------
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0), pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

/** true / false, or null when the marker can't be read (the caller then keeps the dependency). */
export function evalMarker(marker: string): boolean | null {
  const toks = marker.match(/\(|\)|"[^"]*"|'[^']*'|==|!=|<=|>=|~=|<|>|\bnot in\b|\bin\b|\band\b|\bor\b|[\w.]+/g) ?? [];
  let i = 0;
  const val = (t: string) => (/^["']/.test(t) ? t.slice(1, -1) : t in PY ? PY[t] : t === 'extra' ? null : undefined);
  const atom = (): boolean | null => {
    if (toks[i] === '(') { i++; const v = or(); i++; return v; }
    const l = val(toks[i++]), op = toks[i++], r = val(toks[i++]);
    if (l === null || r === null) return false; // extra == "x": optional extras are never installed
    if (l === undefined || r === undefined || !op) return null;
    const ver = /version/.test(toks[i - 3]) || /version/.test(toks[i - 1]);
    const c = ver ? cmpVersion(l, r) : l < r ? -1 : l > r ? 1 : 0;
    switch (op) {
      case '==': return c === 0; case '!=': return c !== 0; case '<': return c < 0; case '<=': return c <= 0;
      case '>': return c > 0; case '>=': return c >= 0; case '~=': return c >= 0; case 'in': return r.includes(l); case 'not in': return !r.includes(l);
    }
    return null;
  };
  const and = (): boolean | null => { let v = atom(); while (toks[i] === 'and') { i++; const w = atom(); v = v === false || w === false ? false : v === null || w === null ? null : true; } return v; };
  const or = (): boolean | null => { let v = and(); while (toks[i] === 'or') { i++; const w = and(); v = v === true || w === true ? true : v === null || w === null ? null : false; } return v; };
  try { return or(); } catch { return null; }
}

/** Requires-Dist lines of a wheel's METADATA → the names to install (extras skipped, markers evaluated). */
export function requiresFromMetadata(metadata: string): string[] {
  const out: string[] = [];
  for (const line of metadata.split(/\r?\n/)) {
    const m = /^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)[^;]*(?:;\s*(.*))?$/.exec(line);
    if (!m) continue;
    if (m[2] && evalMarker(m[2]) === false) continue;
    out.push(m[1]);
  }
  return out;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FetchedWheel { file: string; data: Uint8Array }
export interface PackageLog { name: string; version?: string; file?: string; status: 'installed' | 'bundled' | 'problem'; detail: string }

/**
 * Looks up each name on PyPI, downloads its newest pure-Python wheel, checks the sha256, and follows its
 * dependencies. Sends only package names (in the PyPI URL). `fetchFn` is injectable for tests.
 */
export async function fetchPackages(names: string[], fetchFn: typeof fetch = fetch, onStatus: (s: string) => void = () => {}): Promise<{ wheels: FetchedWheel[]; log: PackageLog[] }> {
  const wheels: FetchedWheel[] = [];
  const log: PackageLog[] = [];
  const seen = new Set<string>();
  const queue = names.map((n) => n.trim()).filter(Boolean);
  while (queue.length) {
    const name = queue.shift()!;
    const key = normName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (BUNDLED.has(key)) { log.push({ name, status: 'bundled', detail: 'already part of Lynceus' }); continue; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { log.push({ name, status: 'problem', detail: 'not a valid package name, so it was not sent' }); continue; }
    if (wheels.length >= MAX_PACKAGES) { log.push({ name, status: 'problem', detail: `stopped at ${MAX_PACKAGES} packages` }); continue; }
    onStatus(`Looking up ${name} on PyPI…`);
    let meta: { info?: { version?: string }; urls?: { filename: string; url: string; packagetype: string; size: number; digests?: { sha256?: string } }[] };
    try {
      const r = await fetchFn(`${PYPI}/pypi/${encodeURIComponent(name)}/json`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (r.status === 404) { log.push({ name, status: 'problem', detail: 'no package with this name on PyPI' }); continue; }
      if (!r.ok) { log.push({ name, status: 'problem', detail: `PyPI answered ${r.status}` }); continue; }
      meta = await r.json();
    } catch (e) { log.push({ name, status: 'problem', detail: `could not reach PyPI (${(e as Error).message})` }); continue; }
    const pure = (meta.urls ?? []).find((u) => u.packagetype === 'bdist_wheel' && /-(py3|py2\.py3)-none-any\.whl$/.test(u.filename));
    if (!pure) { log.push({ name, version: meta.info?.version, status: 'problem', detail: 'no pure-Python wheel (it needs compiled code, which Pyodide cannot install from PyPI)' }); continue; }
    if (!pure.url.startsWith(PYPI_FILES + '/')) { log.push({ name, status: 'problem', detail: 'the download is not on files.pythonhosted.org, so it was refused' }); continue; }
    if (pure.size > MAX_WHEEL_BYTES) { log.push({ name, status: 'problem', detail: `the wheel is over ${MAX_WHEEL_BYTES / 1e6} MB` }); continue; }
    const want = pure.digests?.sha256;
    if (!want) { log.push({ name, status: 'problem', detail: 'PyPI listed no sha256, so it was refused' }); continue; }
    onStatus(`Downloading ${pure.filename}…`);
    let data: Uint8Array;
    try {
      const r = await fetchFn(pure.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) { log.push({ name, status: 'problem', detail: `download failed (${r.status})` }); continue; }
      data = new Uint8Array(await r.arrayBuffer());
    } catch (e) { log.push({ name, status: 'problem', detail: `download failed (${(e as Error).message})` }); continue; }
    if ((await sha256Hex(data)) !== want) { log.push({ name, status: 'problem', detail: 'sha256 did not match what PyPI lists, so it was refused' }); continue; }
    let deps: string[] = [];
    try {
      const entries = unzipSync(data, { filter: (f) => /\.dist-info\/METADATA$/.test(f.name) });
      const md = Object.values(entries)[0];
      if (md) deps = requiresFromMetadata(strFromU8(md));
    } catch { /* unreadable METADATA: install it without dependencies */ }
    wheels.push({ file: pure.filename, data });
    log.push({ name, version: meta.info?.version, file: pure.filename, status: 'installed', detail: `sha256 checked${deps.length ? `; needs ${deps.join(', ')}` : ''}` });
    queue.push(...deps);
  }
  return { wheels, log };
}

// ---------- switching modes (the page reloads, so the loaded code is carried over for this tab only) ----------
const CARRY = 'lynceus.carry';

export function switchPackagesMode(on: boolean, workspace: Workspace | null): void {
  try { if (workspace) sessionStorage.setItem(CARRY, JSON.stringify(workspace)); } catch { /* too big or blocked: the code is not carried */ }
  const base = location.pathname.replace(/[^/]*$/, '');
  location.assign(base + (on ? PACKAGES_PAGE : ''));
}

/** Reads and immediately deletes a workspace carried across the mode switch. */
export function takeCarried(): Workspace | null {
  try {
    const raw = sessionStorage.getItem(CARRY);
    if (!raw) return null;
    sessionStorage.removeItem(CARRY);
    return JSON.parse(raw) as Workspace;
  } catch { return null; }
}
