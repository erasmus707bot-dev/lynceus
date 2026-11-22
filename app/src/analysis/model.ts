// Shared, language-agnostic analysis model. Every language adapter produces exactly this,
// so every view (code, queue, tests, report) stays language-agnostic.
// Lines are 1-based; columns are 0-based.

export type Role = 'mutation' | 'io' | 'control' | 'pure' | 'unknown';
export type Certainty = 'certain' | 'heuristic';

/** Precedence when one statement has several roles: the most review-worthy wins. */
export const ROLE_ORDER: Role[] = ['io', 'mutation', 'unknown', 'control', 'pure'];
export const ROLE_LETTER: Record<Role, string> = { mutation: 'M', io: 'I', control: 'C', pure: 'P', unknown: 'U' };
export const ROLE_LABEL: Record<Role, string> = {
  mutation: 'State mutation', io: 'I/O / side effect', control: 'Control flow', pure: 'Pure computation', unknown: 'Unknown call',
};

export interface Span { line: number; col: number; endLine: number; endCol: number }

/** One piece of evidence: which rule fired, on what, and how sure we are. Source is always the syntax tree in Phase 2. */
export interface Evidence {
  role: Role;
  rule: string;        // stable rule id, e.g. "assign.attribute", "call.io.list"
  detail: string;      // human-readable: what exactly matched
  certainty: Certainty;
  source: 'syntax tree';
}

export interface Statement {
  id: string;
  span: Span;
  headerEnd: number;   // last line of the statement's own text (block statements: the header only)
  kind: string;        // e.g. "Assign", "If", "ExpressionStatement"
  role: Role;          // primary role (highest in ROLE_ORDER among evidence)
  certainty: Certainty;// certainty of the evidence that decided the primary role
  evidence: Evidence[];
  fn: string | null;   // id of the innermost enclosing function, or null at module level
}

export interface Block {
  id: string;
  span: Span;
  headerEnd: number;
  kind: string;        // "function", "class", "if", "for", "while", "try", "with", "switch", ...
  label: string;       // "for loop", "function save", ...
  level: number;       // control-nesting level inside its function (1 = not inside another control block); functions/classes = 0
  summary: string;     // built from the syntax tree, e.g. "for loop · 2 branches · writes total · calls save()"
}

export interface FunctionInfo {
  id: string;
  name: string;
  qualname: string;    // e.g. "Cart.add"
  span: Span;
  params: string[];
  calls: string[];     // callee names as written
  maxLevel: number;    // deepest control nesting level inside it
  role: Role;          // summary role of the whole function (local calls propagated)
  complexity?: number; // McCabe cyclomatic complexity (1 + decision points), from the syntax tree
  callSites?: CallSite[];
}

/**
 * One call written in the code. kind: 'local' = resolved to a function in the uploaded code (target = its id);
 * 'known' = matched a rule list (built-in or library); 'unresolved' = the tool can't tell what it calls.
 */
export interface CallSite { name: string; line: number; target: string | null; kind: 'local' | 'known' | 'unresolved'; rule: string }

/** Code proven unreachable from the syntax tree (after return/raise/throw/break/continue, or under `if False`). */
export interface Unreachable { line: number; endLine: number; reason: string }

/** One read or write of a name. Columns are string indices into the line (UTF-16, like JS strings). */
export interface Ref { line: number; col: number; endCol: number; access: 'decl' | 'read' | 'write' | 'readwrite' }

/**
 * A declared name and every place it is used, from scope analysis of the syntax tree (brief §6.6 lens).
 * fn = innermost function it is declared in (null = module level); fnTarget = the function this name defines, if any.
 */
export interface Binding {
  id: string;
  name: string;
  kind: 'variable' | 'param' | 'function' | 'class' | 'import';
  fn: string | null;
  fnTarget?: string;
  exported?: boolean;
  /** For imports: the loaded file it comes from (null = outside the upload) and the imported name. */
  from?: { path: string | null; name: string };
  refs: Ref[];
  certainty: Certainty;
  note?: string;       // why it is heuristic, when it is
}

export type CheckId = 'unused-function' | 'unused-variable' | 'unused-import' | 'duplicate' | 'unreachable' | 'broad-catch'
  | 'mutable-default' | 'loose-equality' | 'secret' | 'todo' | 'placeholder';

/** One extra static check result (brief §6.7). Every finding names its rule, evidence and certainty. */
export interface Finding {
  id: string;
  check: CheckId;
  rule: string;
  line: number;
  endLine: number;
  fn: string | null;   // enclosing function id, if any
  detail: string;      // what exactly matched (secrets are never included in clear text)
  certainty: Certainty;
  source: 'syntax tree' | 'comments' | 'syntax tree + call graph';
}

/** Where a possible secret sits, so the code view and exports can mask it. */
export interface SecretSpan { line: number; col: number; endLine: number; endCol: number }

/** Normalized syntax-tree hash of a run of statements (names and constants ignored), for duplicate detection. */
export interface DupWindow { hash: string; line: number; endLine: number; fn: string | null }

export interface FileAnalysis {
  path: string;
  lang: 'python' | 'javascript';
  ok: boolean;
  error?: { message: string; line: number; col: number };
  statements: Statement[];
  blocks: Block[];
  functions: FunctionInfo[];
  unreachable?: Unreachable[];
  moduleCalls?: CallSite[]; // calls made at module level (not inside any function)
  bindings?: Binding[];
  findings?: Finding[];
  secrets?: SecretSpan[];
  dupWindows?: DupWindow[];
}

export interface Analysis { files: FileAnalysis[]; ms: number }

export function primary(evidence: Evidence[]): { role: Role; certainty: Certainty } {
  for (const r of ROLE_ORDER) {
    const hits = evidence.filter((e) => e.role === r);
    if (!hits.length) continue;
    // One certain proof is enough to show an effect; "pure" is only certain if every piece of evidence for it is.
    if (r === 'pure') return { role: r, certainty: hits.every((e) => e.certainty === 'certain') ? 'certain' : 'heuristic' };
    return { role: r, certainty: hits.some((e) => e.certainty === 'certain') ? 'certain' : 'heuristic' };
  }
  return { role: 'pure', certainty: 'certain' };
}
