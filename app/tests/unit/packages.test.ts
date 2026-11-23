// @vitest-environment node
// Package downloads (Phase 7): names only, pure-Python wheels only, sha256 checked, dependencies followed.
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { evalMarker, requiresFromMetadata, missingFromMessages, suggestDists, fetchPackages, PYPI, PYPI_FILES } from '../../src/lib/packages';

export function wheel(name: string, version: string, requires: string[] = [], code = 'VALUE = 42\n') {
  return zipSync({
    [`${name}/__init__.py`]: strToU8(code),
    [`${name}-${version}.dist-info/METADATA`]: strToU8(`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n${requires.map((r) => `Requires-Dist: ${r}`).join('\n')}\n`),
  });
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function fakePyPI(pkgs: Record<string, { version: string; data?: Uint8Array; file?: string; url?: string; badSha?: boolean; noPure?: boolean }>) {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    const m = /\/pypi\/([^/]+)\/json$/.exec(url);
    if (m) {
      const p = pkgs[decodeURIComponent(m[1])];
      if (!p) return new Response('nope', { status: 404 });
      const file = p.file ?? `${m[1]}-${p.version}-py3-none-any.whl`;
      const urls = p.noPure ? [{ filename: `${m[1]}-${p.version}-cp314-cp314-manylinux.whl`, url: `${PYPI_FILES}/x/${m[1]}.whl`, packagetype: 'bdist_wheel', size: 10, digests: { sha256: 'x' } }]
        : [{ filename: file, url: p.url ?? `${PYPI_FILES}/packages/${file}`, packagetype: 'bdist_wheel', size: p.data!.length, digests: { sha256: p.badSha ? '0'.repeat(64) : sha(p.data!) } }];
      return new Response(JSON.stringify({ info: { version: p.version }, urls }), { status: 200 });
    }
    const hit = Object.values(pkgs).find((p) => p.data && p.file && url.endsWith(p.file) && url.startsWith(PYPI_FILES));
    const byName = Object.entries(pkgs).find(([n, p]) => url.endsWith(`/${n}-${p.version}-py3-none-any.whl`));
    const data = (hit ?? byName?.[1])?.data;
    return data ? new Response(data as BodyInit, { status: 200 }) : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, asked };
}

describe('environment markers and Requires-Dist', () => {
  it('evaluates the markers Pyodide cares about', () => {
    expect(evalMarker('python_version < "3.11"')).toBe(false);
    expect(evalMarker('python_version >= "3.8"')).toBe(true);
    expect(evalMarker('sys_platform == "win32"')).toBe(false);
    expect(evalMarker('extra == "socks"')).toBe(false);
    expect(evalMarker('(sys_platform == "win32" or python_version >= "3.9") and os_name == "posix"')).toBe(true);
    expect(evalMarker('platform_release == "5"')).toBe(null);
  });
  it('keeps real dependencies, drops extras and non-matching markers', () => {
    const md = 'Name: x\nRequires-Dist: idna>=2.5\nRequires-Dist: PySocks!=1.5.7; extra == "socks"\nRequires-Dist: colorama; sys_platform == "win32"\nRequires-Dist: tomli; python_version < "3.11"\nRequires-Dist: certifi\n';
    expect(requiresFromMetadata(md)).toEqual(['idna', 'certifi']);
  });
});

describe('missing packages from test messages', () => {
  it('finds names, skips what Lynceus already has, maps import names', () => {
    expect(missingFromMessages(["Missing package 'yaml'. Package downloads…", "x Missing package 'requests.adapters'.", "Missing package 'pytest'"])).toEqual(['requests', 'yaml']);
    expect(suggestDists(['requests', 'yaml', 'bs4'])).toEqual(['requests', 'PyYAML', 'beautifulsoup4']);
  });
});

describe('fetchPackages', () => {
  it('downloads a pure wheel, checks sha256 and follows dependencies; sends only names', async () => {
    const { f, asked } = fakePyPI({ tinyreq: { version: '1.0', data: wheel('tinyreq', '1.0', ['tinydep>=1', 'win; sys_platform == "win32"']) }, tinydep: { version: '2.1', data: wheel('tinydep', '2.1') } });
    const r = await fetchPackages(['tinyreq'], f);
    expect(r.wheels.map((w) => w.file)).toEqual(['tinyreq-1.0-py3-none-any.whl', 'tinydep-2.1-py3-none-any.whl']);
    expect(r.log.map((l) => [l.name, l.status])).toEqual([['tinyreq', 'installed'], ['tinydep', 'installed']]);
    expect(asked.every((u) => u.startsWith(PYPI + '/pypi/') || u.startsWith(PYPI_FILES + '/'))).toBe(true);
    expect(asked.some((u) => u.includes('win'))).toBe(false);
  });
  it('refuses a wheel whose sha256 does not match, a download off files.pythonhosted.org, and compiled-only packages', async () => {
    const data = wheel('a', '1');
    const { f } = fakePyPI({ bad: { version: '1', data, badSha: true }, off: { version: '1', data, url: 'https://evil.example/off.whl' }, native: { version: '1', noPure: true } });
    const r = await fetchPackages(['bad', 'off', 'native', 'ghost', 'pytest', 'bad name!'], f);
    expect(r.wheels).toEqual([]);
    const why = Object.fromEntries(r.log.map((l) => [l.name, l.detail]));
    expect(why.bad).toMatch(/sha256 did not match/);
    expect(why.off).toMatch(/not on files\.pythonhosted\.org/);
    expect(why.native).toMatch(/no pure-Python wheel/);
    expect(why.ghost).toMatch(/no package with this name/);
    expect(why.pytest).toMatch(/already part of Lynceus/);
    expect(why['bad name!']).toMatch(/not a valid package name/);
  });
});
