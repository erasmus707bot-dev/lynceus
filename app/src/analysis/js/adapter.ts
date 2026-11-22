// JavaScript adapter: @babel/parser syntax tree -> shared analysis model.
// Every role comes from a rule in rules/javascript.json or from scope analysis of the tree.
import { parse } from '@babel/parser';
import type * as T from '@babel/types';
import RULES from '../../../rules/javascript.json';
import type { Block, Evidence, FileAnalysis, FunctionInfo, Role, Span, Statement } from '../model';
import { primary } from '../model';
import { matchAny } from '../rules';
import type { SourceFile } from '../../lib/types';
import type { LanguageAdapter } from '../adapter';
import { jsExtras } from './extras';

type Node = T.Node;
type Rules = typeof RULES;

interface Scope { names: Set<string>; fnBoundary: boolean; parent: Scope | null; kind: 'module' | 'function' }

interface PendingCall { ev: Evidence; target: string; stmt: Statement }

interface FileCtx {
  file: SourceFile;
  idx: number;
  out: FileAnalysis;
  counter: number;
  /** names bound by require()/import from a relative path -> resolved file path + imported name */
  imports: Map<string, { path: string; name: string }>;
  /** top-level function names in this file -> function id */
  topFns: Map<string, string>;
  /** class name -> method name -> function id */
  classMethods: Map<string, Map<string, string>>;
}

const span = (n: Node): Span => ({
  line: n.loc!.start.line, col: n.loc!.start.column, endLine: n.loc!.end.line, endCol: n.loc!.end.column,
});

const isFn = (n: Node): n is T.Function =>
  n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' ||
  n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod' || n.type === 'ObjectMethod';

/** Dotted name for a callee / member chain: console.log, this.items.push, a.b.c. null if not a simple chain. */
export function dotted(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'Super') return 'super';
  if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
    const obj = dotted(n.object);
    if (!obj) return null;
    if (!n.computed && n.property.type === 'Identifier') return `${obj}.${n.property.name}`;
    if (!n.computed && n.property.type === 'PrivateName') return `${obj}.#${n.property.id.name}`;
    if (n.computed && n.property.type === 'StringLiteral') return `${obj}.${n.property.value}`;
    return `${obj}[]`;
  }
  return null;
}

const rootName = (n: Node): string | null => {
  let cur: Node = n;
  while (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') cur = cur.object;
  return cur.type === 'Identifier' ? cur.name : cur.type === 'ThisExpression' ? 'this' : null;
};

/** Children of a node, in source order, skipping location metadata. */
function children(n: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && 'type' in x) out.push(x as Node); }
    else if (v && typeof v === 'object' && 'type' in (v as object)) out.push(v as Node);
  }
  return out;
}

/** Names declared directly in a function body or program (var/let/const/function/class, simplified to function scope). */
function declaredNames(body: Node, params: Node[] = []): Set<string> {
  const names = new Set<string>();
  const addPattern = (p: Node | null | undefined) => {
    if (!p) return;
    if (p.type === 'Identifier') names.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((q) => addPattern(q.type === 'RestElement' ? q.argument : (q as T.ObjectProperty).value as Node));
    else if (p.type === 'ArrayPattern') p.elements.forEach((e) => addPattern(e as Node));
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
    else if (p.type === 'TSParameterProperty') addPattern(p.parameter as Node);
  };
  params.forEach(addPattern);
  const visit = (n: Node) => {
    if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => addPattern(d.id));
    else if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) names.add(n.id.name);
    else if (n.type === 'ImportDeclaration') n.specifiers.forEach((s) => names.add(s.local.name));
    else if (n.type === 'CatchClause' && n.param) addPattern(n.param);
    if (isFn(n) || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return; // their insides are their own scope
    for (const c of children(n)) visit(c);
  };
  for (const c of children(body)) visit(c);
  return names;
}

function resolveRelative(from: string, spec: string, paths: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = (dir ? dir + '/' + spec : spec).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  const base = out.join('/');
  for (const cand of [base, base + '.js', base + '.mjs', base + '.cjs', base + '.jsx', base + '/index.js']) if (paths.has(cand)) return cand;
  return null;
}

function isFalsyLiteral(n: Node): boolean {
  return (n.type === 'BooleanLiteral' && !n.value) || (n.type === 'NumericLiteral' && n.value === 0) || n.type === 'NullLiteral' ||
    (n.type === 'StringLiteral' && n.value === '') || (n.type === 'Identifier' && n.name === 'undefined');
}
function literalText(n: Node): string {
  if (n.type === 'BooleanLiteral') return String(n.value);
  if (n.type === 'NumericLiteral') return String(n.value);
  if (n.type === 'NullLiteral') return 'null';
  if (n.type === 'StringLiteral') return "''";
  return 'undefined';
}

const CONTROL_LABEL: Record<string, string> = {
  IfStatement: 'if', ForStatement: 'for loop', ForInStatement: 'for…in loop', ForOfStatement: 'for…of loop',
  WhileStatement: 'while loop', DoWhileStatement: 'do…while loop', SwitchStatement: 'switch', TryStatement: 'try',
  CatchClause: 'catch', LabeledStatement: 'labeled block', BlockStatement: 'block',
};

export class JsAnalyzer {
  private rules: Rules;
  private fns = new Map<string, FunctionInfo>();
  private fnStatements = new Map<string, Statement[]>();
  private pending: PendingCall[] = [];
  private ctxs: FileCtx[] = [];
  private paths = new Set<string>();
  private nodeFn = new Map<Node, string>();

  constructor(rules: Rules = RULES) { this.rules = rules; }

  analyze(files: SourceFile[]): FileAnalysis[] {
    this.paths = new Set(files.map((f) => f.path));
    const parsed: { ctx: FileCtx; ast: T.File | null }[] = [];
    files.forEach((file, idx) => {
      const out: FileAnalysis = { path: file.path, lang: 'javascript', ok: true, statements: [], blocks: [], functions: [], unreachable: [], moduleCalls: [] };
      const ctx: FileCtx = { file, idx, out, counter: 0, imports: new Map(), topFns: new Map(), classMethods: new Map() };
      this.ctxs.push(ctx);
      try {
        const ast = parse(file.text, { sourceType: 'unambiguous', plugins: ['jsx'], allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
        parsed.push({ ctx, ast });
      } catch (e) {
        const err = e as Error & { loc?: { line: number; column: number } };
        out.ok = false;
        out.error = { message: err.message.replace(/\s*\(\d+:\d+\)$/, ''), line: err.loc?.line ?? 1, col: err.loc?.column ?? 0 };
        parsed.push({ ctx, ast: null });
      }
    });
    // Pass 1: top-level functions, classes, imports (so calls across files can resolve).
    for (const { ctx, ast } of parsed) if (ast) this.collectTop(ctx, ast.program);
    // Pass 2: statements.
    for (const { ctx, ast } of parsed) if (ast) {
      const scope: Scope = { names: declaredNames(ast.program), fnBoundary: true, parent: null, kind: 'module' };
      this.body(ctx, ast.program.body, scope, null, 0, null);
    }
    this.resolveLocalCalls();
    // Pass 3: scope-aware bindings (lens) and the extra static checks.
    for (const { ctx, ast } of parsed) if (ast) {
      try { jsExtras({ ast, text: ctx.file.text, out: ctx.out, idx: ctx.idx, fnOfNode: this.nodeFn, imports: ctx.imports }); }
      catch (e) { ctx.out.findings = []; ctx.out.bindings = []; console.warn('extra checks failed for', ctx.file.path, e); }
    }
    return this.ctxs.map((c) => c.out);
  }

  // ---------- pass 1 ----------
  private collectTop(ctx: FileCtx, program: T.Program) {
    const fnId = (name: string) => `${ctx.idx}:fn:${name}`;
    const visitDecl = (n: Node) => {
      if (n.type === 'FunctionDeclaration' && n.id) ctx.topFns.set(n.id.name, fnId(n.id.name));
      if (n.type === 'VariableDeclaration') for (const d of n.declarations) {
        if (d.id.type === 'Identifier' && d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) ctx.topFns.set(d.id.name, fnId(d.id.name));
        // const x = require('./y')  /  const { a, b: c } = require('./y')
        if (d.init && d.init.type === 'CallExpression' && d.init.callee.type === 'Identifier' && d.init.callee.name === 'require' && d.init.arguments[0]?.type === 'StringLiteral') {
          const target = resolveRelative(ctx.file.path, d.init.arguments[0].value, this.paths);
          if (target) {
            if (d.id.type === 'Identifier') ctx.imports.set(d.id.name, { path: target, name: '*' });
            if (d.id.type === 'ObjectPattern') for (const p of d.id.properties) if (p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.value.type === 'Identifier') ctx.imports.set(p.value.name, { path: target, name: p.key.name });
          }
        }
      }
      if (n.type === 'ClassDeclaration' && n.id) {
        const m = new Map<string, string>();
        for (const el of n.body.body) if ((el.type === 'ClassMethod' || el.type === 'ClassPrivateMethod') && el.key.type === 'Identifier') m.set(el.key.name, `${ctx.idx}:fn:${n.id.name}.${el.key.name}`);
        ctx.classMethods.set(n.id.name, m);
      }
      if (n.type === 'ImportDeclaration') {
        const target = resolveRelative(ctx.file.path, n.source.value, this.paths);
        if (target) for (const s of n.specifiers) {
          if (s.type === 'ImportSpecifier') ctx.imports.set(s.local.name, { path: target, name: s.imported.type === 'Identifier' ? s.imported.name : s.imported.value });
          else ctx.imports.set(s.local.name, { path: target, name: s.type === 'ImportDefaultSpecifier' ? 'default' : '*' });
        }
      }
      if ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') && n.declaration) visitDecl(n.declaration as Node);
    };
    program.body.forEach(visitDecl);
  }

  // ---------- pass 2 ----------
  private nextId(ctx: FileCtx, kind: string) { return `${ctx.idx}:${kind}:${ctx.counter++}`; }

  private body(ctx: FileCtx, stmts: Node[], scope: Scope, fn: string | null, level: number, cls: string | null) {
    let deadAfter: string | null = null;
    for (const s of stmts) {
      // function declarations are hoisted, so they are not dead even after a return
      if (deadAfter && s.type !== 'FunctionDeclaration' && s.type !== 'EmptyStatement') this.markUnreachable(ctx, s, `comes after ${deadAfter} in the same block, so it can never run`);
      this.statement(ctx, s, scope, fn, level, cls);
      if (!deadAfter && (s.type === 'ReturnStatement' || s.type === 'ThrowStatement' || s.type === 'BreakStatement' || s.type === 'ContinueStatement'))
        deadAfter = `${s.type.replace('Statement', '').toLowerCase()} (line ${s.loc!.start.line})`;
    }
    // `if (false)` / `while (false)` bodies are proven never to run
    for (const s of stmts) {
      if ((s.type === 'IfStatement' || s.type === 'WhileStatement') && isFalsyLiteral(s.test)) {
        const body = s.type === 'IfStatement' ? s.consequent : s.body;
        this.markUnreachable(ctx, body, `sits under \`${s.type === 'IfStatement' ? 'if' : 'while'} (${literalText(s.test)})\` (line ${s.loc!.start.line}), which is never true`);
      }
    }
  }

  private markUnreachable(ctx: FileCtx, n: Node, reason: string) {
    ctx.out.unreachable!.push({ line: n.loc!.start.line, endLine: n.loc!.end.line, reason });
  }

  /** McCabe cyclomatic complexity: 1 + decision points, not counting nested functions. */
  private complexity(n: T.Function): number {
    let c = 1;
    const visit = (x: Node, top: boolean) => {
      if (!top && isFn(x)) return;
      switch (x.type) {
        case 'IfStatement': case 'ConditionalExpression': case 'ForStatement': case 'ForInStatement': case 'ForOfStatement':
        case 'WhileStatement': case 'DoWhileStatement': case 'CatchClause': c++; break;
        case 'SwitchCase': if (x.test) c++; break;
        case 'LogicalExpression': c++; break;
        case 'AssignmentExpression': if (x.operator === '&&=' || x.operator === '||=' || x.operator === '??=') c++; break;
      }
      for (const ch of children(x)) visit(ch, false);
    };
    visit(n.body as Node, true);
    return c;
  }

  private headerEnd(n: Node, body: Node | null | undefined): number {
    if (!body || !body.loc) return n.loc!.end.line;
    return Math.max(n.loc!.start.line, body.loc.start.line - (body.type === 'BlockStatement' && body.loc.start.line > n.loc!.start.line ? 0 : 0));
  }

  private addStatement(ctx: FileCtx, n: Node, kind: string, evidence: Evidence[], fn: string | null, headerEnd?: number): Statement {
    const p = primary(evidence);
    const st: Statement = { id: this.nextId(ctx, 's'), span: span(n), headerEnd: headerEnd ?? n.loc!.end.line, kind, role: p.role, certainty: p.certainty, evidence, fn };
    ctx.out.statements.push(st);
    if (fn) { const arr = this.fnStatements.get(fn) ?? []; arr.push(st); this.fnStatements.set(fn, arr); }
    for (const ev of evidence) { const t = (ev as Evidence & { _target?: string })._target; if (t) this.pending.push({ ev, target: t, stmt: st }); }
    return st;
  }

  private addBlock(ctx: FileCtx, n: Node, kind: string, label: string, level: number, headerEnd: number, inner: Node[]) {
    const b: Block = { id: this.nextId(ctx, 'b'), span: span(n), headerEnd, kind, label, level, summary: '' };
    b.summary = this.summarize(label, n, inner);
    ctx.out.blocks.push(b);
    return b;
  }

  private control(rule: string, detail: string): Evidence {
    return { role: 'control', rule, detail, certainty: 'certain', source: 'syntax tree' };
  }

  private statement(ctx: FileCtx, n: Node, scope: Scope, fn: string | null, level: number, cls: string | null): void {
    switch (n.type) {
      case 'EmptyStatement': return;
      case 'ExpressionStatement': {
        const ev = this.expr(ctx, n.expression, scope, fn, cls);
        this.addStatement(ctx, n, n.type, ev.length ? ev : [{ role: 'pure', rule: 'expr.plain', detail: 'expression with no calls or writes', certainty: 'certain', source: 'syntax tree' }], fn);
        this.nestedFns(ctx, n.expression, scope, fn, cls);
        return;
      }
      case 'VariableDeclaration': {
        const ev: Evidence[] = [];
        for (const d of n.declarations) if (d.init) ev.push(...this.expr(ctx, d.init, scope, fn, cls));
        const names = n.declarations.map((d) => (d.id.type === 'Identifier' ? d.id.name : '…')).join(', ');
        ev.push({ role: 'pure', rule: 'declare.local', detail: `declares local ${n.kind} ${names}`, certainty: 'certain', source: 'syntax tree' });
        // a top-level `const f = () => {...}` is a function definition, not a call
        this.addStatement(ctx, n, n.type, ev, fn);
        for (const d of n.declarations) if (d.init) {
          if ((d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') && d.id.type === 'Identifier') this.func(ctx, d.init, d.id.name, scope, fn, cls, n);
          else this.nestedFns(ctx, d.init, scope, fn, cls);
        }
        return;
      }
      case 'FunctionDeclaration': this.func(ctx, n, n.id?.name ?? '(anonymous)', scope, fn, cls, n); return;
      case 'ClassDeclaration': case 'ClassExpression': this.klass(ctx, n, scope, fn); return;
      case 'ReturnStatement': case 'ThrowStatement': {
        const ev = [this.control(n.type === 'ReturnStatement' ? 'control.return' : 'control.throw', n.type === 'ReturnStatement' ? 'return' : 'throw')];
        if (n.argument) ev.push(...this.expr(ctx, n.argument, scope, fn, cls));
        this.addStatement(ctx, n, n.type, ev, fn);
        if (n.argument) this.nestedFns(ctx, n.argument, scope, fn, cls);
        return;
      }
      case 'BreakStatement': case 'ContinueStatement':
        this.addStatement(ctx, n, n.type, [this.control(n.type === 'BreakStatement' ? 'control.break' : 'control.continue', n.type === 'BreakStatement' ? 'break' : 'continue')], fn);
        return;
      case 'IfStatement': {
        const ev = [this.control('control.if', 'if: chooses a branch'), ...this.expr(ctx, n.test, scope, fn, cls)];
        const he = n.consequent.loc!.start.line;
        this.addStatement(ctx, n, n.type, ev, fn, Math.max(n.loc!.start.line, n.consequent.type === 'BlockStatement' ? he : he - 1));
        this.addBlock(ctx, n, 'if', 'if', level + 1, n.consequent.loc!.start.line, [n.consequent, ...(n.alternate ? [n.alternate] : [])]);
        this.blockBody(ctx, n.consequent, scope, fn, level + 1, cls);
        if (n.alternate) {
          if (n.alternate.type === 'IfStatement') this.statement(ctx, n.alternate, scope, fn, level, cls); // else-if stays at the same level
          else this.blockBody(ctx, n.alternate, scope, fn, level + 1, cls);
        }
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'WhileStatement': case 'DoWhileStatement': {
        const ev: Evidence[] = [this.control('control.loop', CONTROL_LABEL[n.type])];
        const parts: (Node | null | undefined)[] = n.type === 'ForStatement' ? [n.init, n.test, n.update]
          : n.type === 'ForInStatement' || n.type === 'ForOfStatement' ? [n.right] : [n.test];
        for (const p of parts) if (p) ev.push(...this.expr(ctx, p, scope, fn, cls));
        if ((n.type === 'ForOfStatement' && n.await)) ev.push(this.control('control.await', 'for await'));
        this.addStatement(ctx, n, n.type, ev, fn, n.body.loc!.start.line);
        this.addBlock(ctx, n, 'loop', CONTROL_LABEL[n.type], level + 1, n.body.loc!.start.line, [n.body]);
        this.blockBody(ctx, n.body, scope, fn, level + 1, cls);
        return;
      }
      case 'SwitchStatement': {
        const ev = [this.control('control.switch', 'switch: chooses a case'), ...this.expr(ctx, n.discriminant, scope, fn, cls)];
        const first = n.cases[0]?.loc?.start.line ?? n.loc!.end.line;
        this.addStatement(ctx, n, n.type, ev, fn, Math.max(n.loc!.start.line, first - 1));
        this.addBlock(ctx, n, 'switch', 'switch', level + 1, Math.max(n.loc!.start.line, first - 1), n.cases);
        for (const c of n.cases) {
          if (c.test) this.addStatement(ctx, c, 'SwitchCase', [this.control('control.case', 'case'), ...this.expr(ctx, c.test, scope, fn, cls)], fn, c.test.loc!.end.line);
          else this.addStatement(ctx, c, 'SwitchCase', [this.control('control.case', 'default case')], fn, c.loc!.start.line);
          this.body(ctx, c.consequent, scope, fn, level + 1, cls);
        }
        return;
      }
      case 'TryStatement': {
        this.addStatement(ctx, n, n.type, [this.control('control.try', 'try: errors jump to catch/finally')], fn, n.block.loc!.start.line);
        this.addBlock(ctx, n, 'try', 'try', level + 1, n.block.loc!.start.line, [n.block, ...(n.handler ? [n.handler] : []), ...(n.finalizer ? [n.finalizer] : [])]);
        this.blockBody(ctx, n.block, scope, fn, level + 1, cls);
        if (n.handler) {
          this.addStatement(ctx, n.handler, 'CatchClause', [this.control('control.catch', n.handler.param ? 'catch (error)' : 'catch')], fn, n.handler.body.loc!.start.line);
          this.blockBody(ctx, n.handler.body, scope, fn, level + 1, cls);
        }
        if (n.finalizer) this.blockBody(ctx, n.finalizer, scope, fn, level + 1, cls);
        return;
      }
      case 'LabeledStatement': this.statement(ctx, n.body, scope, fn, level, cls); return;
      case 'BlockStatement': this.body(ctx, n.body, scope, fn, level, cls); return;
      case 'ImportDeclaration':
        this.addStatement(ctx, n, n.type, [{ role: 'pure', rule: 'module.import', detail: `import from "${n.source.value}"`, certainty: 'certain', source: 'syntax tree' }], fn);
        return;
      case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration':
        if (n.declaration && n.declaration.type !== 'Identifier' && !(n.declaration.type.endsWith('Expression') && n.type === 'ExportDefaultDeclaration' && !isFn(n.declaration) && n.declaration.type !== 'ClassExpression')) {
          this.statement(ctx, n.declaration as Node, scope, fn, level, cls);
        } else {
          const ev = n.type === 'ExportDefaultDeclaration' && n.declaration ? this.expr(ctx, n.declaration as Node, scope, fn, cls) : [];
          ev.push({ role: 'pure', rule: 'module.export', detail: 'export', certainty: 'certain', source: 'syntax tree' });
          this.addStatement(ctx, n, n.type, ev, fn);
        }
        return;
      case 'ExportAllDeclaration':
        this.addStatement(ctx, n, n.type, [{ role: 'pure', rule: 'module.export', detail: 'export *', certainty: 'certain', source: 'syntax tree' }], fn);
        return;
      default: {
        // Anything else (with, debugger, TS-only nodes): keep it visible as unknown rather than guessing.
        this.addStatement(ctx, n, n.type, [{ role: 'unknown', rule: 'statement.unsupported', detail: `statement type ${n.type} is not classified`, certainty: 'certain', source: 'syntax tree' }], fn);
      }
    }
  }

  private blockBody(ctx: FileCtx, n: Node, scope: Scope, fn: string | null, level: number, cls: string | null) {
    if (n.type === 'BlockStatement') this.body(ctx, n.body, scope, fn, level, cls);
    else this.statement(ctx, n, scope, fn, level, cls);
  }

  private func(ctx: FileCtx, n: T.Function, name: string, scope: Scope, parentFn: string | null, cls: string | null, stmtNode: Node) {
    const qual = cls ? `${cls}.${name}` : name;
    const id = (!parentFn && (ctx.topFns.get(name) && !cls)) ? ctx.topFns.get(name)! : cls && ctx.classMethods.get(cls)?.get(name) ? ctx.classMethods.get(cls)!.get(name)! : this.nextId(ctx, 'fn');
    const params = n.params.map((p) => (p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : '…'));
    const info: FunctionInfo = { id, name, qualname: qual, span: span(stmtNode.type === 'VariableDeclaration' ? stmtNode : n), params, calls: [], maxLevel: 0, role: 'pure', complexity: this.complexity(n), callSites: [] };
    this.fns.set(id, info);
    this.nodeFn.set(n, id);
    ctx.out.functions.push(info);
    if (stmtNode === n || stmtNode.type !== 'VariableDeclaration') {
      this.addStatement(ctx, n, 'FunctionDefinition', [{ role: 'pure', rule: 'define.function', detail: `defines function ${qual}(${params.join(', ')})`, certainty: 'certain', source: 'syntax tree' }], parentFn, n.body.loc!.start.line);
    }
    const inner = n.body.type === 'BlockStatement' ? n.body.body : [n.body];
    this.addBlock(ctx, stmtNode.type === 'VariableDeclaration' ? stmtNode : n, 'function', `function ${qual}`, 0, n.body.loc!.start.line, inner as Node[]);
    const fscope: Scope = { names: declaredNames(n.body, n.params as Node[]), fnBoundary: true, parent: scope, kind: 'function' };
    if (n.body.type === 'BlockStatement') this.body(ctx, n.body.body, fscope, id, 0, cls);
    else {
      // expression-bodied arrow: its expression is an implicit return
      const ev = [this.control('control.return', 'implicit return (arrow function)'), ...this.expr(ctx, n.body, fscope, id, cls)];
      this.addStatement(ctx, n.body, 'ArrowBody', ev, id);
      this.nestedFns(ctx, n.body, fscope, id, cls);
    }
    const levels = ctx.out.blocks.filter((b) => b.kind !== 'function' && b.kind !== 'class' && b.span.line >= info.span.line && b.span.endLine <= info.span.endLine).map((b) => b.level);
    info.maxLevel = Math.max(0, ...levels.filter((l) => l > 0));
  }

  private klass(ctx: FileCtx, n: T.ClassDeclaration | T.ClassExpression, scope: Scope, fn: string | null) {
    const name = n.id?.name ?? '(anonymous class)';
    const ev: Evidence[] = [{ role: 'pure', rule: 'define.class', detail: `defines class ${name}`, certainty: 'certain', source: 'syntax tree' }];
    if (n.superClass) ev.push(...this.expr(ctx, n.superClass, scope, fn, null));
    this.addStatement(ctx, n, 'ClassDefinition', ev, fn, n.body.loc!.start.line);
    this.addBlock(ctx, n, 'class', `class ${name}`, 0, n.body.loc!.start.line, n.body.body as Node[]);
    for (const el of n.body.body) {
      if ((el.type === 'ClassMethod' || el.type === 'ClassPrivateMethod') && (el.key.type === 'Identifier' || el.key.type === 'PrivateName')) {
        const mname = el.key.type === 'Identifier' ? el.key.name : '#' + el.key.id.name;
        this.func(ctx, el, mname, scope, fn, name, el);
      } else if (el.type === 'ClassProperty' && el.value) {
        this.addStatement(ctx, el, 'ClassProperty', [...this.expr(ctx, el.value, scope, fn, name), { role: 'pure', rule: 'declare.field', detail: 'class field', certainty: 'certain', source: 'syntax tree' }], fn);
      }
    }
  }

  /** Function expressions nested inside an expression with a block body get their own statements. */
  private nestedFns(ctx: FileCtx, n: Node, scope: Scope, fn: string | null, cls: string | null) {
    const visit = (x: Node) => {
      if ((x.type === 'FunctionExpression' || x.type === 'ArrowFunctionExpression') && x.body.type === 'BlockStatement') {
        this.func(ctx, x, x.type === 'FunctionExpression' && x.id ? x.id.name : '(callback)', scope, fn, cls, x);
        return;
      }
      if (x.type === 'ArrowFunctionExpression') return; // expression-bodied arrows are counted in the enclosing statement
      if (x.type === 'ClassExpression') { this.klass(ctx, x, scope, fn); return; }
      for (const c of children(x)) visit(c);
    };
    visit(n);
  }

  // ---------- expressions ----------
  private isLocal(name: string, scope: Scope): 'local' | 'outer' | 'module' | 'undeclared' {
    let s: Scope | null = scope;
    let crossed = false;
    while (s) {
      if (s.names.has(name)) return !crossed ? 'local' : s.kind === 'module' ? 'module' : 'outer';
      if (s.fnBoundary) crossed = true;
      s = s.parent;
    }
    return 'undeclared';
  }

  private writeTarget(ctx: FileCtx, target: Node, scope: Scope, fn: string | null, op: string): Evidence[] {
    const ev: Evidence[] = [];
    if (target.type === 'Identifier') {
      const where = this.isLocal(target.name, scope);
      if (where === 'local' || (fn === null && where !== 'undeclared')) ev.push({ role: 'pure', rule: 'assign.local', detail: `${op} local variable ${target.name}`, certainty: 'certain', source: 'syntax tree' });
      else if (where === 'undeclared') ev.push({ role: 'mutation', rule: 'assign.global', detail: `${op} ${target.name}, which is not declared anywhere in this code (a global)`, certainty: 'certain', source: 'syntax tree' });
      else ev.push({ role: 'mutation', rule: 'assign.outer', detail: `${op} ${target.name}, declared outside this function (${where} scope)`, certainty: 'certain', source: 'syntax tree' });
    } else if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') {
      const name = dotted(target) ?? 'a property';
      ev.push({ role: 'mutation', rule: target.computed ? 'assign.subscript' : 'assign.attribute', detail: `${op} ${name}`, certainty: 'certain', source: 'syntax tree' });
      const root = rootName(target);
      const prop = !target.computed && target.property.type === 'Identifier' ? target.property.name : null;
      if (root && ['document', 'window', 'location', 'navigator', 'history'].includes(root) && this.isLocal(root, scope) === 'undeclared')
        ev.push({ role: 'io', rule: 'io.dom-global-write', detail: `${op} ${name} (browser global)`, certainty: 'certain', source: 'syntax tree' });
      else if (prop && this.rules.dom_write_props.includes(prop))
        ev.push({ role: 'io', rule: 'io.dom-write', detail: `${op} .${prop}, usually a DOM write`, certainty: 'heuristic', source: 'syntax tree' });
    } else if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern') {
      for (const c of children(target)) {
        const inner = c.type === 'ObjectProperty' ? (c.value as Node) : c.type === 'RestElement' ? c.argument : c.type === 'AssignmentPattern' ? c.left : c;
        if (inner) ev.push(...this.writeTarget(ctx, inner, scope, fn, op));
      }
    }
    return ev;
  }

  private call(ctx: FileCtx, n: T.CallExpression | T.NewExpression | T.OptionalCallExpression, scope: Scope, fn: string | null, cls: string | null): Evidence {
    const ev = this.callEvidence(ctx, n, scope, fn, cls);
    const target = (ev as Evidence & { _target?: string })._target ?? null;
    const kind = ev.rule === 'call.local' ? 'local' : ev.rule === 'call.unknown' || ev.rule === 'call.dynamic-import' ? 'unresolved' : 'known';
    const site = { name: dotted(n.callee as Node) ?? '(expression)', line: n.loc!.start.line, target, kind, rule: ev.rule } as const;
    if (fn && this.fns.get(fn)) this.fns.get(fn)!.callSites!.push({ ...site });
    else ctx.out.moduleCalls!.push({ ...site });
    return ev;
  }

  private callEvidence(ctx: FileCtx, n: T.CallExpression | T.NewExpression | T.OptionalCallExpression, scope: Scope, fn: string | null, cls: string | null): Evidence {
    const callee = n.callee as Node;
    const name = dotted(callee);
    const shown = (name ?? '(expression)') + '()';
    if (fn) this.fns.get(fn)?.calls.push(name ?? '(expression)');
    if (callee.type === 'Import') return { role: 'unknown', rule: 'call.dynamic-import', detail: 'dynamic import()', certainty: 'certain', source: 'syntax tree' };
    if (name === 'require') return { role: 'pure', rule: 'module.require', detail: 'require(): loads a module', certainty: 'certain', source: 'syntax tree' };
    // 1. calls to functions defined in the uploaded code
    if (name && !name.includes('.')) {
      const where = this.isLocal(name, scope);
      const top = ctx.topFns.get(name);
      const imp = ctx.imports.get(name);
      let target: string | undefined;
      if (top && (where === 'module' || where === 'local' || where === 'outer')) target = top;
      else if (imp) target = this.ctxs.find((c) => c.file.path === imp.path)?.topFns.get(imp.name === 'default' ? name : imp.name);
      if (!target) {
        // nested function declared in an enclosing function
        for (const f of this.fns.values()) if (f.name === name && f.id.startsWith(`${ctx.idx}:`)) { target = f.id; break; }
      }
      if (target) return Object.assign({ role: 'pure' as Role, rule: 'call.local', detail: `calls ${shown}, defined in the uploaded code`, certainty: 'certain' as const, source: 'syntax tree' as const }, { _target: target });
    }
    if (name && name.includes('.')) {
      const [head, ...rest] = name.split('.');
      // this.method() inside a class -> that class's method
      if (head === 'this' && cls && rest.length === 1) {
        const target = ctx.classMethods.get(cls)?.get(rest[0]);
        if (target) return Object.assign({ role: 'pure' as Role, rule: 'call.local', detail: `calls ${shown}, a method of class ${cls}`, certainty: 'certain' as const, source: 'syntax tree' as const }, { _target: target });
      }
      // imported module namespace: calc.add() where calc = require('./calc')
      const imp = ctx.imports.get(head);
      if (imp && imp.name === '*' && rest.length === 1) {
        const target = this.ctxs.find((c) => c.file.path === imp.path)?.topFns.get(rest[0]);
        if (target) return Object.assign({ role: 'pure' as Role, rule: 'call.local', detail: `calls ${shown}, defined in ${imp.path}`, certainty: 'certain' as const, source: 'syntax tree' as const }, { _target: target });
      }
    }
    if (name) {
      const shadowed = this.isLocal(name.split('.')[0], scope) !== 'undeclared';
      if (!shadowed) {
        let p = matchAny(name, this.rules.io.certain);
        if (p) return { role: 'io', rule: 'call.io', detail: `${shown} matches I/O rule "${p}"`, certainty: 'certain', source: 'syntax tree' };
        p = matchAny(name, this.rules.mutating_statics.certain);
        if (p) return { role: 'mutation', rule: 'call.mutating-builtin', detail: `${shown} changes its first argument (rule "${p}")`, certainty: 'certain', source: 'syntax tree' };
        p = matchAny(name, this.rules.pure.certain);
        if (p) return { role: 'pure', rule: 'call.pure-builtin', detail: `${shown} is a known pure built-in (rule "${p}")`, certainty: 'certain', source: 'syntax tree' };
      }
      // library rules are heuristic even when the name is a local binding (e.g. const fs = require('fs'))
      const lib = matchAny(name, this.rules.io.heuristic);
      if (lib) return { role: 'io', rule: 'call.io-library', detail: `${shown} matches library I/O rule "${lib}"`, certainty: 'heuristic', source: 'syntax tree' };
    }
    // method calls by name
    if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
      const m = !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : null;
      const recv = dotted(callee.object) ?? 'an object';
      if (m && this.rules.mutating_methods.heuristic.includes(m)) return { role: 'mutation', rule: 'call.mutating-method', detail: `.${m}() usually changes ${recv} in place`, certainty: 'heuristic', source: 'syntax tree' };
      if (m && this.rules.pure.heuristic_methods.includes(m)) return { role: 'pure', rule: 'call.pure-method', detail: `.${m}() usually returns a new value without side effects`, certainty: 'heuristic', source: 'syntax tree' };
    }
    return { role: 'unknown', rule: 'call.unknown', detail: `${shown} is not defined in the uploaded code and is not on a known list`, certainty: 'certain', source: 'syntax tree' };
  }

  /** Evidence from an expression, not descending into block-bodied functions (they are analyzed on their own). */
  expr(ctx: FileCtx, n: Node, scope: Scope, fn: string | null, cls: string | null): Evidence[] {
    const ev: Evidence[] = [];
    const visit = (x: Node, sc: Scope) => {
      switch (x.type) {
        case 'FunctionExpression': case 'ClassExpression': return;
        case 'ArrowFunctionExpression': {
          if (x.body.type === 'BlockStatement') return;
          const inner: Scope = { names: declaredNames(x.body, x.params as Node[]), fnBoundary: true, parent: sc, kind: 'function' };
          visit(x.body, inner);
          return;
        }
        case 'CallExpression': case 'NewExpression': case 'OptionalCallExpression':
          ev.push(this.call(ctx, x, sc, fn, cls));
          break;
        case 'AssignmentExpression':
          ev.push(...this.writeTarget(ctx, x.left, sc, fn, x.operator === '=' ? 'assigns' : `updates (${x.operator})`));
          visit(x.right, sc);
          if (x.left.type === 'MemberExpression') { visit(x.left.object, sc); if (x.left.computed) visit(x.left.property, sc); }
          return;
        case 'UpdateExpression':
          ev.push(...this.writeTarget(ctx, x.argument, sc, fn, `updates (${x.operator})`));
          return;
        case 'UnaryExpression':
          if (x.operator === 'delete') { ev.push({ role: 'mutation', rule: 'delete.property', detail: `delete ${dotted(x.argument) ?? 'a property'}`, certainty: 'certain', source: 'syntax tree' }); return; }
          break;
        case 'AwaitExpression': ev.push(this.control('control.await', 'await: pauses until a promise settles')); break;
        case 'YieldExpression': ev.push(this.control('control.yield', 'yield: pauses the generator')); break;
        case 'MemberExpression': case 'OptionalMemberExpression': {
          const name = dotted(x);
          const p = name && this.isLocal(name.split('.')[0], sc) === 'undeclared' ? matchAny(name, this.rules.io_reads.certain) : null;
          if (p) { ev.push({ role: 'io', rule: 'read.environment', detail: `reads ${name} (environment / browser state)`, certainty: 'certain', source: 'syntax tree' }); return; }
          break;
        }
        case 'TaggedTemplateExpression':
          ev.push({ role: 'unknown', rule: 'call.unknown', detail: `tagged template ${dotted(x.tag) ?? ''}\`…\` calls a function`, certainty: 'certain', source: 'syntax tree' });
          break;
      }
      for (const c of children(x)) visit(c, sc);
    };
    visit(n, scope);
    return ev;
  }

  // ---------- summaries ----------
  private summarize(label: string, root: Node, inner: Node[]): string {
    let branches = 0;
    const writes: string[] = [];
    const calls: string[] = [];
    const add = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };
    const visit = (x: Node, top: boolean) => {
      if (!top && isFn(x)) return;
      if (x.type === 'IfStatement') branches += x.alternate && x.alternate.type !== 'IfStatement' ? 2 : x.alternate ? 1 : 2;
      if (x.type === 'ConditionalExpression') branches += 2;
      if (x.type === 'SwitchCase') branches += 1;
      if (x.type === 'CatchClause') branches += 1;
      if (x.type === 'AssignmentExpression' || x.type === 'UpdateExpression') {
        const t = x.type === 'AssignmentExpression' ? x.left : x.argument;
        const nm = dotted(t as Node);
        if (nm) add(writes, nm);
      }
      if (x.type === 'CallExpression' || x.type === 'NewExpression' || x.type === 'OptionalCallExpression') { const nm = dotted(x.callee as Node); if (nm) add(calls, nm + '()'); }
      for (const c of children(x)) visit(c, false);
    };
    if (root.type === 'IfStatement' || root.type === 'SwitchStatement' || root.type === 'TryStatement') visit(root, true);
    else for (const i of inner) visit(i, false);
    const parts = [label];
    if (branches) parts.push(`${branches} branch${branches === 1 ? '' : 'es'}`);
    if (writes.length) parts.push(`writes ${writes.slice(0, 3).join(', ')}${writes.length > 3 ? ` +${writes.length - 3}` : ''}`);
    if (calls.length) parts.push(`calls ${calls.slice(0, 3).join(', ')}${calls.length > 3 ? ` +${calls.length - 3}` : ''}`);
    return parts.join(' · ');
  }

  // ---------- interprocedural ----------
  /** Fixed point: a call to a local function takes that function's summary role. */
  private resolveLocalCalls() {
    const fnRole = (id: string): { role: Role; certainty: 'certain' | 'heuristic' } => {
      const sts = this.fnStatements.get(id) ?? [];
      const ev = sts.flatMap((s) => s.evidence).filter((e) => e.role === 'io' || e.role === 'mutation' || e.role === 'unknown');
      return ev.length ? primary(ev) : { role: 'pure', certainty: 'certain' };
    };
    for (let i = 0; i < 20; i++) {
      let changed = false;
      for (const pc of this.pending) {
        const callee = this.fns.get(pc.target);
        if (!callee) continue;
        const r = fnRole(pc.target);
        const detail = `calls ${callee.qualname}(), defined in the uploaded code; that function's role is ${r.role}`;
        if (pc.ev.role !== r.role || pc.ev.certainty !== r.certainty || pc.ev.detail !== detail) {
          pc.ev.role = r.role; pc.ev.certainty = r.certainty; pc.ev.detail = detail; changed = true;
        }
      }
      if (!changed) break;
    }
    for (const c of this.ctxs) for (const s of c.out.statements) { const p = primary(s.evidence); s.role = p.role; s.certainty = p.certainty; }
    for (const f of this.fns.values()) f.role = fnRole(f.id).role;
    for (const pc of this.pending) delete (pc.ev as Evidence & { _target?: string })._target;
  }
}

export const jsAdapter: LanguageAdapter = {
  lang: 'javascript',
  async analyze(files) { return new JsAnalyzer().analyze(files); },
};
