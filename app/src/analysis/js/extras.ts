// JavaScript: scope-aware bindings for the lens (brief §6.6) and the file-local extra checks (§6.7).
// Scope comes from Babel's own scope tracker (@babel/traverse), so reads and writes are matched to the
// right declaration. Cross-file checks (unused functions, duplicates across files) live in review/checks.ts.
import traverseMod from '@babel/traverse';
import type * as T from '@babel/types';
import type { Binding, Certainty, DupWindow, FileAnalysis, Finding, Ref, SecretSpan } from '../model';
import { maskValue, scanSecret } from '../secrets';
import { normalizedHash } from '../dup';

type Node = T.Node;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPath = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse: (ast: Node, visitors: any) => void = (traverseMod as any).default ?? traverseMod;

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra', 'range']);

export interface JsExtrasInput {
  ast: T.File;
  text: string;
  out: FileAnalysis;
  idx: number;
  fnOfNode: Map<Node, string>;
  imports: Map<string, { path: string; name: string }>;
}

export function jsExtras({ ast, text, out, idx, fnOfNode, imports }: JsExtrasInput): void {
  const bindings: Binding[] = [];
  const findings: Finding[] = [];
  const secrets: SecretSpan[] = [];
  const dupWindows: DupWindow[] = [];
  let n = 0;
  const fid = () => `${idx}:f:${n++}`;
  const enclosingFn = (path: AnyPath): string | null => {
    for (let p = path; p; p = p.parentPath) { const id = fnOfNode.get(p.node); if (id) return id; }
    return null;
  };
  const add = (f: Omit<Finding, 'id' | 'source'> & { source?: Finding['source'] }) => findings.push({ id: fid(), source: 'syntax tree', ...f });

  const usesEval = /\beval\s*\(|\bwith\s*\(/.test(text);
  const isModule = ast.program.sourceType === 'module' || /\b(require\s*\(|module\.exports|exports\.)/.test(text);

  // ---------- bindings (scope-aware) ----------
  const seen = new Set<object>();
  const loc = (node: Node, access: Ref['access']): Ref | null =>
    node.loc && node.loc.start.line === node.loc.end.line ? { line: node.loc.start.line, col: node.loc.start.column, endCol: node.loc.end.column, access } : null;

  const isCjsExport = (p: AnyPath): boolean => {
    for (let q = p.parentPath; q && !q.isStatement(); q = q.parentPath) {
      if (q.isAssignmentExpression()) {
        const left = q.node.left;
        const s = left.type === 'MemberExpression' ? memberName(left) : null;
        if (s && (s.startsWith('module.exports') || s.startsWith('exports.'))) return true;
      }
    }
    return false;
  };

  const collect = (scope: AnyPath) => {
    for (const [name, b] of Object.entries(scope.bindings ?? {}) as [string, AnyPath][]) {
      if (seen.has(b)) continue;
      seen.add(b);
      const bp = b.path;
      if (bp.isCatchClause?.()) continue; // catch (e): listed nowhere, unused-ness is normal
      let kind: Binding['kind'] = 'variable';
      let fnTarget: string | undefined;
      if (b.kind === 'module') kind = 'import';
      else if (b.kind === 'param') kind = 'param';
      else if (bp.isFunctionDeclaration() || bp.isFunctionExpression()) { kind = 'function'; fnTarget = fnOfNode.get(bp.node); }
      else if (bp.isClassDeclaration() || bp.isClassExpression()) kind = 'class';
      else if (bp.isVariableDeclarator() && bp.node.id.type === 'Identifier' && bp.node.init &&
               (bp.node.init.type === 'ArrowFunctionExpression' || bp.node.init.type === 'FunctionExpression')) { kind = 'function'; fnTarget = fnOfNode.get(bp.node.init); }
      const refs: Ref[] = [];
      const push = (r: Ref | null) => { if (r && !refs.some((x) => x.line === r.line && x.col === r.col)) refs.push(r); };
      push(loc(b.identifier, 'decl'));
      let exported = false;
      const decl = bp.isVariableDeclarator() ? bp.parentPath : bp;
      if (decl?.parentPath?.isExportNamedDeclaration() || decl?.parentPath?.isExportDefaultDeclaration()) exported = true;
      for (const rp of b.referencePaths as AnyPath[]) {
        if (rp.parentPath?.isExportSpecifier() || rp.parentPath?.isExportDefaultDeclaration()) exported = true;
        else if (isCjsExport(rp)) exported = true;
        push(loc(rp.node, 'read'));
      }
      for (const cv of b.constantViolations as AnyPath[]) {
        const nd = cv.node;
        if (nd.type === 'UpdateExpression' && nd.argument.type === 'Identifier') { push(loc(nd.argument, 'readwrite')); continue; }
        const access: Ref['access'] = nd.type === 'AssignmentExpression' && nd.operator !== '=' ? 'readwrite' : 'write';
        const ids = cv.getBindingIdentifiers?.(true)?.[name] as Node | Node[] | undefined;
        for (const id of ids ? (Array.isArray(ids) ? ids : [ids]) : []) push(loc(id, access));
      }
      refs.sort((a, c) => a.line - c.line || a.col - c.col);
      const fnDeclared = enclosingFn(bp.isVariableDeclarator() ? bp.parentPath : bp.parentPath ?? bp);
      let certainty: Certainty = 'certain';
      let note: string | undefined;
      if (usesEval) { certainty = 'heuristic'; note = 'the file uses eval() or with, so names can be reached in ways the syntax tree does not show'; }
      else if (!fnDeclared && !isModule && scope.path.isProgram()) { certainty = 'heuristic'; note = 'a top-level name in a classic script is global, so other scripts may use it'; }
      const imp = kind === 'import' ? imports.get(name) : undefined;
      let from: Binding['from'];
      if (kind === 'import') {
        const spec = bp.node;
        const iname = spec.type === 'ImportSpecifier' ? (spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value) : spec.type === 'ImportDefaultSpecifier' ? 'default' : '*';
        from = { path: imp?.path ?? null, name: imp?.name ?? iname };
      } else if (imp) { kind = 'import'; from = { path: imp.path, name: imp.name }; }
      bindings.push({ id: `${idx}:v:${bindings.length}`, name, kind, fn: fnDeclared, fnTarget, exported, from, refs, certainty, note });

      // unused variables and imports (functions are checked across files in review/checks.ts)
      const reads = refs.filter((r) => r.access === 'read' || r.access === 'readwrite').length;
      const line = b.identifier.loc?.start.line ?? 1;
      if (!reads && !exported && !name.startsWith('_')) {
        if (kind === 'import' && !(name === 'React' && /<[A-Za-z]/.test(text))) {
          add({ check: 'unused-import', rule: 'unused.import', line, endLine: line, fn: fnDeclared, detail: `"${name}" is imported but never used`, certainty, ...(note ? { detail: `"${name}" is imported but never used (${note})` } : {}) });
        } else if (kind === 'variable' || kind === 'class') {
          const restSibling = bp.isVariableDeclarator() && bp.node.id.type === 'ObjectPattern' && bp.node.id.properties.some((p: Node) => p.type === 'RestElement');
          const writes = refs.filter((r) => r.access === 'write').length;
          const what = writes ? 'is assigned but never read' : 'is declared but never used';
          add({ check: 'unused-variable', rule: 'unused.variable', line, endLine: line, fn: fnDeclared,
            detail: `"${name}" ${what}${restSibling ? ' (it may be there on purpose, to leave it out of a ...rest copy)' : note ? ` (${note})` : ''}`,
            certainty: restSibling ? 'heuristic' : certainty });
        }
      }
    }
  };

  // ---------- one walk for everything else ----------
  traverse(ast, {
    Scopable: { enter(path: AnyPath) { collect(path.scope); } },
    Program: { enter(path: AnyPath) { collect(path.scope); } },
    CatchClause(path: AnyPath) {
      const body = path.node.body.body;
      if (!body.length) add({ check: 'broad-catch', rule: 'catch.empty', line: path.node.loc.start.line, endLine: path.node.loc.end.line, fn: enclosingFn(path), detail: 'empty catch block: every error is silently ignored', certainty: 'certain' });
    },
    CallExpression(path: AnyPath) {
      const c = path.node;
      const f = c.arguments[0];
      if (c.callee.type === 'MemberExpression' && !c.callee.computed && c.callee.property.type === 'Identifier' && c.callee.property.name === 'catch' &&
          f && (f.type === 'ArrowFunctionExpression' || f.type === 'FunctionExpression') && f.body.type === 'BlockStatement' && !f.body.body.length)
        add({ check: 'broad-catch', rule: 'catch.promise-empty', line: c.loc.start.line, endLine: c.loc.end.line, fn: enclosingFn(path), detail: '.catch() with an empty handler: promise errors are silently ignored', certainty: 'heuristic' });
    },
    BinaryExpression(path: AnyPath) {
      const b = path.node;
      if (b.operator !== '==' && b.operator !== '!=') return;
      const nullish = (x: Node) => x.type === 'NullLiteral' || (x.type === 'Identifier' && x.name === 'undefined');
      const strict = b.operator === '==' ? '===' : '!==';
      if (nullish(b.left) || nullish(b.right))
        add({ check: 'loose-equality', rule: 'eq.loose-null', line: b.loc.start.line, endLine: b.loc.end.line, fn: enclosingFn(path), detail: `\`${b.operator} null\` also matches undefined; this is a common idiom and may be on purpose`, certainty: 'heuristic' });
      else
        add({ check: 'loose-equality', rule: 'eq.loose', line: b.loc.start.line, endLine: b.loc.end.line, fn: enclosingFn(path), detail: `\`${b.operator}\` converts types before comparing (so 0 == '' is true); \`${strict}\` doesn't`, certainty: 'certain' });
    },
    StringLiteral(path: AnyPath) {
      const p = path.parentPath;
      if (p.isImportDeclaration() || p.isExportDeclaration() || (p.isCallExpression() && p.node.callee.type === 'Identifier' && p.node.callee.name === 'require') || p.isObjectProperty({ key: path.node })) return;
      secret(path, path.node.value, path.node.loc, true);
    },
    TemplateElement(path: AnyPath) { secret(path, path.node.value.cooked ?? path.node.value.raw, path.node.loc, false); },
    Function(path: AnyPath) {
      const node = path.node;
      const id = fnOfNode.get(node);
      if (!id || node.body.type !== 'BlockStatement') return;
      const info = out.functions.find((f) => f.id === id);
      if (!info || info.name === '(callback)') return;
      const body = node.body.body;
      const line = info.span.line;
      if (!body.length && !(node.body.innerComments?.length))
        add({ check: 'placeholder', rule: 'placeholder.empty', line, endLine: info.span.endLine, fn: id, detail: `${info.qualname}() has an empty body`, certainty: 'certain' });
      else if (body.length === 1 && body[0].type === 'ThrowStatement') {
        const arg = body[0].argument;
        const msg = (arg?.type === 'NewExpression' || arg?.type === 'CallExpression') && arg.arguments[0]?.type === 'StringLiteral' ? arg.arguments[0].value : '';
        if (/not\s*implemented|todo|implement me|stub/i.test(msg))
          add({ check: 'placeholder', rule: 'placeholder.not-implemented', line, endLine: info.span.endLine, fn: id, detail: `${info.qualname}() only throws "${msg.slice(0, 60)}"`, certainty: 'certain' });
      }
    },
    'Program|BlockStatement|SwitchCase'(path: AnyPath) {
      const list: Node[] = path.node.type === 'SwitchCase' ? path.node.consequent : path.node.body;
      windows(list, enclosingFn(path));
    },
  });

  function secret(path: AnyPath, value: string, l: T.SourceLocation | null | undefined, quoted: boolean) {
    if (!l || !value) return;
    const hint = nameHint(path);
    const hit = scanSecret(value, hint);
    if (!hit) return;
    const s: SecretSpan = { line: l.start.line, col: l.start.column + (quoted ? 1 : 0), endLine: l.end.line, endCol: l.end.column - (quoted ? 1 : 0) };
    secrets.push(s);
    add({ check: 'secret', rule: hit.rule, line: s.line, endLine: s.endLine, fn: enclosingFn(path), detail: `possible ${hit.label}: "${maskValue(value)}" (${value.length} characters, masked)`, certainty: hit.certainty });
  }

  function windows(list: Node[], fn: string | null) {
    const stmts = list.filter((s) => s.loc && s.type !== 'ImportDeclaration' && s.type !== 'EmptyStatement');
    for (let i = 0; i < stmts.length; i++) {
      for (let j = i + 1; j < stmts.length; j++) {
        const lines = stmts[j].loc!.end.line - stmts[i].loc!.start.line + 1;
        if (lines < 6) continue;
        const h = normalizedHash(stmts.slice(i, j + 1), (x) => jsNodeParts(x));
        if (!h) { if (lines > 40) break; continue; } // keep growing until the run is big enough to matter
        dupWindows.push({ hash: h, line: stmts[i].loc!.start.line, endLine: stmts[j].loc!.end.line, fn });
        break;
      }
    }
  }

  for (const c of ast.comments ?? []) {
    const m = /\b(TODO|FIXME|XXX|HACK)\b[:\s-]*(.*)/.exec(c.value);
    if (m) add({ check: 'todo', rule: `comment.${m[1].toLowerCase()}`, line: c.loc!.start.line, endLine: c.loc!.start.line, fn: null, detail: `${m[1]} comment${m[2].trim() ? `: ${m[2].trim().slice(0, 80)}` : ''}`, certainty: 'certain', source: 'comments' });
  }
  // attach todo comments to their function
  for (const f of findings) if (f.check === 'todo') f.fn = out.functions.filter((fn) => fn.span.line <= f.line && f.line <= fn.span.endLine).sort((a, b) => b.span.line - a.span.line)[0]?.id ?? null;

  out.bindings = bindings;
  out.findings = findings;
  out.secrets = secrets;
  out.dupWindows = dupWindows;
}

function memberName(n: Node): string | null {
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') { const o = memberName(n.object); return o ? `${o}.${n.property.name}` : null; }
  return null;
}

function nameHint(path: AnyPath): string | null {
  const p = path.parentPath;
  if (!p) return null;
  if (p.isVariableDeclarator() && p.node.id.type === 'Identifier') return p.node.id.name;
  if (p.isObjectProperty() && !p.node.computed) return p.node.key.type === 'Identifier' ? p.node.key.name : p.node.key.type === 'StringLiteral' ? p.node.key.value : null;
  if (p.isAssignmentExpression()) { const m = memberName(p.node.left); return m ? m.split('.').pop()! : null; }
  if (p.isAssignmentPattern() && p.node.left.type === 'Identifier') return p.node.left.name;
  if (p.isTemplateLiteral()) return nameHint(p);
  return null;
}

/** Serializer parts for the normalized hash: node type, children in order, names and constants blanked. */
function jsNodeParts(n: Node): { type: string; name?: string; literal?: boolean; props: string[]; kids: Node[] } {
  const kids: Node[] = [];
  const props: string[] = [];
  for (const k of Object.keys(n)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = (n as unknown as Record<string, unknown>)[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && 'type' in x) kids.push(x as Node); }
    else if (v && typeof v === 'object' && 'type' in (v as object)) kids.push(v as Node);
    else if ((typeof v === 'string' || typeof v === 'boolean') && k !== 'name' && k !== 'value' && k !== 'raw' && k !== 'pattern' && k !== 'flags') props.push(`${k}=${v}`);
  }
  const literal = /Literal$/.test(n.type) || n.type === 'TemplateElement';
  return { type: n.type, name: n.type === 'Identifier' || n.type === 'JSXIdentifier' ? (n as T.Identifier).name : undefined, literal, props, kids };
}
