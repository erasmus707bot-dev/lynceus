// @vitest-environment node
// TypeScript support (Phase 7): the JavaScript adapter and runner, with types ignored.
import { describe, it, expect } from 'vitest';
import { JsAnalyzer } from '../../src/analysis/js/adapter';
import { makeFile, pastedName, langLabel, acceptBytes } from '../../src/lib/files';
import { looksTypeScript, moduleCandidates, unwrapTsExpressions } from '../../src/analysis/ts';
import { detectTests } from '../../src/sandbox/detect-tests';
import { runJs } from '../../src/sandbox/js-runner';
import type { RunInput, WorkerEvent, TestResult } from '../../src/sandbox/protocol';

const CART = `import type { Config } from './types';
import { Logger, unusedThing } from './log';

export interface Item { price: number; qty?: number }
type Total = number;
enum Mode { Fast, Slow }

export class Cart {
  private items: Item[] = [];
  constructor(private readonly log: Logger) {}
  add(item: Item): void {
    this.items.push(item);
    this.log!.info('added');
  }
  total(): Total {
    let t: number = 0;
    for (const i of this.items) {
      if ((i.qty as number) > 0) t += i.price * i.qty!;
    }
    return t satisfies number;
  }
}

export function pick<T>(xs: T[], cfg: Config): T | undefined {
  return xs.find((x) => x !== null);
}
declare function external(x: string): void;
`;

describe('TypeScript analysis', () => {
  const f = makeFile('cart.ts', CART);
  const [fa] = new JsAnalyzer().analyze([f]);

  it('.ts files are accepted and reviewed by the JavaScript adapter', () => {
    expect(f.lang).toBe('javascript');
    expect(langLabel(f)).toBe('TS');
    expect(acceptBytes('src/x.tsx', new TextEncoder().encode('export const x = 1;')).file?.path).toBe('src/x.tsx');
    expect(fa.ok).toBe(true);
  });

  it('type-only declarations are not statements; enums are', () => {
    const kinds = fa.statements.map((s) => s.kind);
    expect(kinds).not.toContain('TSInterfaceDeclaration');
    expect(kinds).not.toContain('TSTypeAliasDeclaration');
    expect(kinds).not.toContain('TSDeclareFunction');
    expect(fa.statements.find((s) => s.kind === 'TSEnumDeclaration')?.role).toBe('pure');
    expect(fa.statements.some((s) => s.role === 'unknown' && s.evidence.some((e) => e.rule === 'statement.unsupported'))).toBe(false);
  });

  it('complexity and nesting ignore types; `as`, `!` and `satisfies` read as the plain value', () => {
    const total = fa.functions.find((x) => x.qualname === 'Cart.total')!;
    expect(total.complexity).toBe(3);
    expect(total.maxLevel).toBe(2);
    const add = fa.functions.find((x) => x.qualname === 'Cart.add')!;
    expect(add.callSites!.map((c) => c.name)).toEqual(['this.items.push', 'this.log.info']);
  });

  it('a name used only in a type counts as used; truly unused imports are still found', () => {
    const unused = (fa.findings ?? []).filter((x) => x.check === 'unused-import' || x.check === 'unused-variable').map((x) => x.detail);
    expect(unused).toEqual(['"unusedThing" is imported but never used']);
    expect(fa.bindings!.find((b) => b.name === 'Config')?.kind).toBe('import');
  });

  it('a constructor with parameter properties is not an empty placeholder', () => {
    expect((fa.findings ?? []).filter((x) => x.check === 'placeholder')).toEqual([]);
  });

  it('unwrapTsExpressions strips nested wrappers', () => {
    const node = { type: 'X', e: { type: 'TSNonNullExpression', expression: { type: 'TSAsExpression', expression: { type: 'Identifier', name: 'a' } } } };
    expect(unwrapTsExpressions(node)).toBe(2);
    expect(node.e).toEqual({ type: 'Identifier', name: 'a' });
  });
});

describe('TypeScript helpers', () => {
  it('module candidates map ./x.js to x.ts', () => {
    expect(moduleCandidates('src/util.js').slice(0, 3)).toEqual(['src/util.js', 'src/util.ts', 'src/util.tsx']);
    expect(moduleCandidates('src/util')).toContain('src/util.ts');
  });
  it('pasted TypeScript is recognised (heuristic) and named .ts', () => {
    expect(looksTypeScript('export function f(a: number): string { return String(a); }')).toBe(true);
    expect(looksTypeScript('interface User { id: number }')).toBe(true);
    expect(looksTypeScript('function f(a) { return a ? 1 : 2; }')).toBe(false);
    expect(pastedName('typescript', 'code')).toBe('pasted.ts');
    expect(makeFile('pasted.ts', 'const x = 1;', 'typescript').lang).toBe('javascript');
  });
  it('test detection finds .test.ts and .spec.tsx files', () => {
    const found = detectTests([{ path: 'a.test.ts', text: "test('x', () => {});", lang: 'javascript' }, { path: 'b.spec.tsx', text: "it('y', () => {});", lang: 'javascript' }]);
    expect(found.map((t) => [t.path, t.inline])).toEqual([['a.test.ts', false], ['b.spec.tsx', false]]);
  });
});

describe('TypeScript tests run with types stripped', () => {
  it('pass, fail and per-line coverage on the original line numbers', async () => {
    const src = `export interface P { n: number }\n\nexport function sign(p: P): number {\n  if (p.n < 0) {\n    return -1;\n  }\n  return 1 as number;\n}\n`;
    const test = `import { sign } from './sign.js';\nimport type { P } from './sign';\n\ndescribe('sign', () => {\n  test('positive', () => { const p: P = { n: 5 }; expect(sign(p)).toBe(1); });\n  test('wrong', () => { expect(sign({ n: 2 })).toBe(7); });\n});\n`;
    const events: WorkerEvent[] = [];
    const input: RunInput = { lang: 'javascript', files: [{ path: 'src/sign.ts', text: src }, { path: 'src/sign.test.ts', text: test }], testFiles: ['src/sign.test.ts'], skip: [], pyodideURL: '' };
    await runJs(input, (e) => events.push(e));
    const results = Object.fromEntries(events.filter((e) => e.type === 'result').map((e) => [(e as { result: TestResult }).result.name, (e as { result: TestResult }).result]));
    expect(results['sign › positive'].outcome).toBe('passed');
    expect(results['sign › wrong'].outcome).toBe('failed');
    const done = events.find((e) => e.type === 'done') as Extract<WorkerEvent, { type: 'done' }>;
    const cov = done.coverage['src/sign.ts'];
    expect(cov.statements).toEqual(expect.arrayContaining([4, 5, 7]));
    expect(cov.lines[5] ?? []).toEqual([]); // `return -1` never ran
    expect(cov.lines[7]).toHaveLength(2);
  });
});
