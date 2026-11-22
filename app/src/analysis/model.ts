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
