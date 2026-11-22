// The two bundled demo projects (repo folder demo/). They ship inside the app, so "Try a demo" works offline.
// Each one is deliberately flawed AI-style code with tests (some failing), a short spec and a small diff.
import { makeFile } from './files';
import type { SourceFile } from './types';

export type DemoId = 'python' | 'javascript';

const raw = import.meta.glob('../../../demo/{python,javascript}/*.{py,js,md,diff}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface Demo { id: DemoId; label: string; files: SourceFile[]; spec: string; diff: string }

export function getDemo(id: DemoId): Demo {
  const prefix = `../../../demo/${id}/`;
  const entries = Object.entries(raw).filter(([p]) => p.startsWith(prefix)).map(([p, text]) => [p.slice(prefix.length), text] as const);
  const files = entries.filter(([n]) => /\.(py|js)$/.test(n)).map(([n, t]) => makeFile(n, t)).sort((a, b) => a.path.localeCompare(b.path));
  return {
    id, label: id === 'python' ? 'Python' : 'JavaScript', files,
    spec: entries.find(([n]) => n === 'SPEC.md')?.[1] ?? '',
    diff: entries.find(([n]) => n === 'change.diff')?.[1] ?? '',
  };
}
