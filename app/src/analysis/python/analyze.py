"""Lynceus Python adapter: Python's own `ast` -> shared analysis model (same JSON shape as model.ts).

Runs inside Pyodide in the analysis worker, and also under plain CPython for tests.
Every role comes from a rule in rules/python.json or from scope analysis of the tree.
Entry point: analyze_json(input_json) -> output_json
  input:  {"files": [{"path": str, "text": str}], "rules": {...}}
  output: [FileAnalysis, ...]
"""
import ast
import json

ROLE_ORDER = ["io", "mutation", "unknown", "control", "pure"]
EFFECT_ROLES = ("io", "mutation", "unknown")


def matches(name, pattern):
    if pattern.endswith(".*"):
        base = pattern[:-2]
        return name == base or name.startswith(base + ".")
    if pattern.endswith("*"):
        return name.startswith(pattern[:-1])
    return name == pattern


def match_any(name, patterns):
    for p in patterns or []:
        if matches(name, p):
            return p
    return None


def primary(evidence):
    for r in ROLE_ORDER:
        hits = [e for e in evidence if e["role"] == r]
        if not hits:
            continue
        if r == "pure":
            cert = "certain" if all(e["certainty"] == "certain" for e in hits) else "heuristic"
        else:
            cert = "certain" if any(e["certainty"] == "certain" for e in hits) else "heuristic"
        return r, cert
    return "pure", "certain"


def ev(role, rule, detail, certainty="certain"):
    return {"role": role, "rule": rule, "detail": detail, "certainty": certainty, "source": "syntax tree"}


def span(n):
    return {"line": n.lineno, "col": n.col_offset, "endLine": n.end_lineno or n.lineno, "endCol": n.end_col_offset or 0}


def dotted(n):
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        base = dotted(n.value)
        return f"{base}.{n.attr}" if base else None
    if isinstance(n, ast.Subscript):
        base = dotted(n.value)
        return f"{base}[]" if base else None
    return None


def module_names(path):
    """'pkg/calc.py' -> {'pkg.calc', 'calc'}"""
    p = path[:-3] if path.endswith(".py") else path
    parts = p.split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    names = {".".join(parts)} if parts else set()
    if parts:
        names.add(parts[-1])
    return names


CONTROL_LABEL = {
    "If": "if", "For": "for loop", "AsyncFor": "async for loop", "While": "while loop", "Try": "try",
    "TryStar": "try", "With": "with", "AsyncWith": "async with", "Match": "match",
}


class FileCtx:
    def __init__(self, idx, path, text):
        self.idx = idx
        self.path = path
        self.text = text
        self.lines = text.split("\n")
        self.counter = 0
        self.imports = {}       # local name -> dotted target ("numpy", "calc.add", ...)
        self.top_fns = {}       # name -> fn id
        self.classes = {}       # class name -> {method: fn id}
        self.out = {"path": path, "lang": "python", "ok": True, "statements": [], "blocks": [], "functions": [],
                    "unreachable": [], "moduleCalls": []}

    def next_id(self, kind):
        i = f"{self.idx}:{kind}:{self.counter}"
        self.counter += 1
        return i


class Scope:
    def __init__(self, kind, parent=None, local_names=(), global_names=(), nonlocal_names=(), fn_defs=None, cls=None):
        self.kind = kind            # "module" | "function" | "class"
        self.parent = parent
        self.locals = set(local_names)
        self.globals = set(global_names)
        self.nonlocals = set(nonlocal_names)
        self.fn_defs = fn_defs or {}  # nested def name -> fn id
        self.cls = cls


def collect_locals(fn):
    """Python's rule: a name assigned anywhere in a function is local, unless declared global/nonlocal."""
    params = []
    a = fn.args
    for arg in a.posonlyargs + a.args + a.kwonlyargs:
        params.append(arg.arg)
    if a.vararg:
        params.append(a.vararg.arg)
    if a.kwarg:
        params.append(a.kwarg.arg)
    assigned, globs, nonlocs = set(params), set(), set()

    def visit(n):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            assigned.add(n.name)
            return  # inner scope
        if isinstance(n, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            return
        if isinstance(n, ast.Global):
            globs.update(n.names)
        elif isinstance(n, ast.Nonlocal):
            nonlocs.update(n.names)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            assigned.add(n.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for al in n.names:
                assigned.add((al.asname or al.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            assigned.add(n.name)
        elif isinstance(n, ast.NamedExpr) and isinstance(n.target, ast.Name):
            assigned.add(n.target.id)
        for c in ast.iter_child_nodes(n):
            visit(c)

    for st in fn.body:
        visit(st)
    return params, assigned - globs - nonlocs, globs, nonlocs


class PyAnalyzer:
    def __init__(self, rules):
        self.rules = rules
        self.ctxs = []
        self.fns = {}
        self.fn_statements = {}
        self.pending = []   # (evidence, target fn id)
        self.module_index = {}  # module name -> FileCtx
        self.node_fn = {}       # FunctionDef node -> fn id (for the Phase 5 extras)

    # ---------- driver ----------
    def analyze(self, files):
        trees = []
        for idx, f in enumerate(files):
            ctx = FileCtx(idx, f["path"], f["text"])
            self.ctxs.append(ctx)
            for m in module_names(f["path"]):
                self.module_index.setdefault(m, ctx)
            try:
                tree = ast.parse(f["text"], filename=f["path"])
                trees.append((ctx, tree))
            except SyntaxError as e:
                ctx.out["ok"] = False
                ctx.out["error"] = {"message": e.msg or "syntax error", "line": e.lineno or 1, "col": max((e.offset or 1) - 1, 0)}
                trees.append((ctx, None))
        for ctx, tree in trees:
            if tree is not None:
                self.collect_top(ctx, tree)
        for ctx, tree in trees:
            if tree is not None:
                mod_locals = set()
                for n in ast.walk(tree):
                    if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                        mod_locals.add(n.id)
                scope = Scope("module", local_names=mod_locals | set(ctx.top_fns) | set(ctx.classes) | set(ctx.imports))
                self.body(ctx, tree.body, scope, None, 0)
        self.resolve_local_calls()
        for ctx, tree in trees:
            if tree is not None:
                try:
                    PyExtras(self, ctx, tree).run()
                except Exception as e:  # never lose the main analysis because of an extra check
                    ctx.out["findings"] = []
                    ctx.out["bindings"] = []
                    ctx.out["extrasError"] = f"{type(e).__name__}: {e}"
        return [c.out for c in self.ctxs]

    def collect_top(self, ctx, tree):
        for n in tree.body:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                ctx.top_fns[n.name] = f"{ctx.idx}:fn:{n.name}"
            elif isinstance(n, ast.ClassDef):
                ctx.classes[n.name] = {m.name: f"{ctx.idx}:fn:{n.name}.{m.name}" for m in n.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))}
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                for al in n.names:
                    if al.asname:
                        ctx.imports[al.asname] = al.name
                    else:
                        head = al.name.split(".")[0]
                        ctx.imports[head] = head
            elif isinstance(n, ast.ImportFrom):
                mod = n.module or ""
                for al in n.names:
                    ctx.imports[al.asname or al.name] = f"{mod}.{al.name}" if mod else al.name

    # ---------- statements ----------
    def add_statement(self, ctx, n, kind, evidence, fn, header_end=None):
        role, cert = primary(evidence)
        st = {"id": ctx.next_id("s"), "span": span(n), "headerEnd": header_end or n.end_lineno or n.lineno,
              "kind": kind, "role": role, "certainty": cert, "evidence": evidence, "fn": fn}
        ctx.out["statements"].append(st)
        if fn:
            self.fn_statements.setdefault(fn, []).append(st)
        for e in evidence:
            t = e.pop("_target", None)
            if t:
                self.pending.append((e, t))
        return st

    def add_block(self, ctx, n, kind, label, level, header_end, inner):
        b = {"id": ctx.next_id("b"), "span": span(n), "headerEnd": header_end, "kind": kind, "label": label,
             "level": level, "summary": self.summarize(label, n, inner)}
        ctx.out["blocks"].append(b)
        return b

    def body(self, ctx, stmts, scope, fn, level):
        dead_after = None
        for s in stmts:
            if dead_after is not None:
                self.mark_unreachable(ctx, s, f"comes after {dead_after} in the same block, so it can never run")
            self.statement(ctx, s, scope, fn, level)
            if dead_after is None and isinstance(s, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
                dead_after = {"Return": "return", "Raise": "raise", "Break": "break", "Continue": "continue"}[type(s).__name__] + f" (line {s.lineno})"
        # `if False:` / `while False:` bodies are proven never to run
        for s in stmts:
            if isinstance(s, (ast.If, ast.While)) and isinstance(s.test, ast.Constant) and s.test.value in (False, 0, None, "") and s.body:
                for b in s.body:
                    self.mark_unreachable(ctx, b, f"sits under `{type(s).__name__.lower()} {ast.unparse(s.test)}:` (line {s.lineno}), which is never true")

    @staticmethod
    def mark_unreachable(ctx, n, reason):
        start = n.decorator_list[0].lineno if getattr(n, "decorator_list", None) else n.lineno
        ctx.out["unreachable"].append({"line": start, "endLine": n.end_lineno or n.lineno, "reason": reason})

    @staticmethod
    def complexity(fn_node):
        """McCabe cyclomatic complexity: 1 + decision points, not counting nested functions or classes."""
        c = 1

        def visit(x):
            nonlocal c
            if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                return
            if isinstance(x, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler)):
                c += 1
            elif isinstance(x, ast.BoolOp):
                c += len(x.values) - 1
            elif isinstance(x, ast.comprehension):
                c += 1 + len(x.ifs)
            elif hasattr(ast, "match_case") and isinstance(x, ast.match_case):
                c += 1
            for ch in ast.iter_child_nodes(x):
                visit(ch)

        for st in fn_node.body:
            visit(st)
        return c

    @staticmethod
    def header_end(n):
        body = getattr(n, "body", None)
        if body and isinstance(body, list) and body:
            return max(n.lineno, body[0].lineno - 1)
        return n.lineno

    def statement(self, ctx, n, scope, fn, level):
        t = type(n).__name__
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.func(ctx, n, scope, fn)
            return
        if isinstance(n, ast.ClassDef):
            self.klass(ctx, n, scope, fn)
            return
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            names = ", ".join(al.name for al in n.names)
            src = f"from {n.module or '.'} import {names}" if isinstance(n, ast.ImportFrom) else f"import {names}"
            self.add_statement(ctx, n, t, [ev("pure", "module.import", src)], fn)
            return
        if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            e = []
            targets = n.targets if isinstance(n, ast.Assign) else [n.target]
            op = "assigns" if not isinstance(n, ast.AugAssign) else f"updates ({type(n.op).__name__})"
            for tg in targets:
                e += self.write_target(tg, scope, fn, op)
            if getattr(n, "value", None) is not None:
                e += self.expr(ctx, n.value, scope, fn)
            for tg in targets:
                e += self.expr_in_target(ctx, tg, scope, fn)
            self.add_statement(ctx, n, t, e, fn)
            return
        if isinstance(n, ast.Delete):
            e = []
            for tg in n.targets:
                e += self.write_target(tg, scope, fn, "deletes")
            self.add_statement(ctx, n, t, e, fn)
            return
        if isinstance(n, ast.Expr):
            e = self.expr(ctx, n.value, scope, fn)
            if not e:
                if isinstance(n.value, ast.Constant) and isinstance(n.value.value, str):
                    e = [ev("pure", "expr.docstring", "docstring")]
                elif isinstance(n.value, ast.Constant) and n.value.value is Ellipsis:
                    e = [ev("pure", "expr.placeholder", "placeholder (...)")]
                else:
                    e = [ev("pure", "expr.plain", "expression with no calls or writes")]
            self.add_statement(ctx, n, t, e, fn)
            return
        if isinstance(n, ast.Pass):
            self.add_statement(ctx, n, t, [ev("pure", "stmt.pass", "pass (does nothing)")], fn)
            return
        if isinstance(n, (ast.Return, ast.Raise)):
            e = [ev("control", "control.return" if isinstance(n, ast.Return) else "control.raise", "return" if isinstance(n, ast.Return) else "raise")]
            for part in ([n.value] if isinstance(n, ast.Return) else [n.exc, n.cause]):
                if part is not None:
                    e += self.expr(ctx, part, scope, fn)
            self.add_statement(ctx, n, t, e, fn)
            return
        if isinstance(n, (ast.Break, ast.Continue)):
            self.add_statement(ctx, n, t, [ev("control", f"control.{t.lower()}", t.lower())], fn)
            return
        if isinstance(n, ast.Assert):
            e = [ev("control", "control.assert", "assert: raises if false")] + self.expr(ctx, n.test, scope, fn)
            if n.msg is not None:
                e += self.expr(ctx, n.msg, scope, fn)
            self.add_statement(ctx, n, t, e, fn)
            return
        if isinstance(n, (ast.Global, ast.Nonlocal)):
            self.add_statement(ctx, n, t, [ev("pure", f"declare.{t.lower()}", f"{t.lower()} {', '.join(n.names)}: later writes change outer state")], fn)
            return
        if isinstance(n, ast.If):
            is_elif = self._is_elif(ctx, n)
            e = [ev("control", "control.if", "elif: chooses a branch" if is_elif else "if: chooses a branch")] + self.expr(ctx, n.test, scope, fn)
            he = self.header_end(n)
            self.add_statement(ctx, n, t, e, fn, he)
            lvl = level if is_elif else level + 1
            if not is_elif:
                self.add_block(ctx, n, "if", "if", lvl, he, n.body + n.orelse)
            self.body(ctx, n.body, scope, fn, lvl)
            if len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If) and self._is_elif(ctx, n.orelse[0]):
                self.statement(ctx, n.orelse[0], scope, fn, lvl - 1 if not is_elif else level)
            else:
                self.body(ctx, n.orelse, scope, fn, lvl)
            return
        if isinstance(n, (ast.For, ast.AsyncFor, ast.While)):
            e = [ev("control", "control.loop", CONTROL_LABEL[t])]
            if isinstance(n, ast.While):
                e += self.expr(ctx, n.test, scope, fn)
            else:
                e += self.write_target(n.target, scope, fn, "loop variable")
                e += self.expr(ctx, n.iter, scope, fn)
                if isinstance(n, ast.AsyncFor):
                    e.append(ev("control", "control.await", "async for"))
            he = self.header_end(n)
            self.add_statement(ctx, n, t, e, fn, he)
            self.add_block(ctx, n, "loop", CONTROL_LABEL[t], level + 1, he, n.body + n.orelse)
            self.body(ctx, n.body, scope, fn, level + 1)
            self.body(ctx, n.orelse, scope, fn, level + 1)
            return
        if isinstance(n, (ast.With, ast.AsyncWith)):
            e = [ev("control", "control.with", "with: enters and exits a context manager")]
            for item in n.items:
                e += self.expr(ctx, item.context_expr, scope, fn)
                if item.optional_vars is not None:
                    e += self.write_target(item.optional_vars, scope, fn, "binds")
            he = self.header_end(n)
            self.add_statement(ctx, n, t, e, fn, he)
            self.add_block(ctx, n, "with", CONTROL_LABEL[t], level + 1, he, n.body)
            self.body(ctx, n.body, scope, fn, level + 1)
            return
        if t in ("Try", "TryStar"):
            he = self.header_end(n)
            self.add_statement(ctx, n, t, [ev("control", "control.try", "try: errors jump to except/finally")], fn, he)
            self.add_block(ctx, n, "try", "try", level + 1, he, n.body + n.handlers + n.orelse + n.finalbody)
            self.body(ctx, n.body, scope, fn, level + 1)
            for h in n.handlers:
                what = f"except {ast.unparse(h.type)}" if h.type is not None else "except (catches everything)"
                self.add_statement(ctx, h, "ExceptHandler", [ev("control", "control.except", what)], fn, self.header_end(h))
                self.body(ctx, h.body, scope, fn, level + 1)
            self.body(ctx, n.orelse, scope, fn, level + 1)
            self.body(ctx, n.finalbody, scope, fn, level + 1)
            return
        if t == "Match":
            he = max(n.lineno, n.cases[0].pattern.lineno - 1) if n.cases else n.lineno
            self.add_statement(ctx, n, t, [ev("control", "control.match", "match: chooses a case")] + self.expr(ctx, n.subject, scope, fn), fn, he)
            self.add_block(ctx, n, "match", "match", level + 1, he, [s for c in n.cases for s in c.body])
            for c in n.cases:
                self.body(ctx, c.body, scope, fn, level + 1)
            return
        # anything else stays visible as unknown rather than guessed
        self.add_statement(ctx, n, t, [ev("unknown", "statement.unsupported", f"statement type {t} is not classified")], fn)

    def _is_elif(self, ctx, n):
        line = ctx.lines[n.lineno - 1] if 0 < n.lineno <= len(ctx.lines) else ""
        return line[n.col_offset:].startswith("elif")

    def func(self, ctx, n, scope, parent_fn):
        cls = scope.cls if scope.kind == "class" else None
        qual = f"{cls}.{n.name}" if cls else n.name
        if cls and n.name in ctx.classes.get(cls, {}):
            fid = ctx.classes[cls][n.name]
        elif scope.kind == "module" and n.name in ctx.top_fns:
            fid = ctx.top_fns[n.name]
        else:
            fid = ctx.next_id("fn")
            scope.fn_defs[n.name] = fid
        params, locs, globs, nonlocs = collect_locals(n)
        info = {"id": fid, "name": n.name, "qualname": qual, "span": span(n), "params": params, "calls": [], "maxLevel": 0, "role": "pure",
                "complexity": self.complexity(n), "callSites": []}
        self.fns[fid] = info
        self.node_fn[n] = fid
        ctx.out["functions"].append(info)
        e = [ev("pure", "define.function", f"defines function {qual}({', '.join(params)})")]
        for d in n.decorator_list:
            e += self.expr(ctx, d, scope, parent_fn)
        for dflt in n.args.defaults + [d for d in n.args.kw_defaults if d is not None]:
            e += self.expr(ctx, dflt, scope, parent_fn)
        he = self.header_end(n)
        start_node = n.decorator_list[0] if n.decorator_list else n
        st = self.add_statement(ctx, n, "FunctionDef", e, parent_fn, he)
        st["span"]["line"] = start_node.lineno
        self.add_block(ctx, n, "function", f"function {qual}", 0, he, n.body)
        nested = {}
        for c in ast.walk(ast.Module(body=n.body, type_ignores=[])):
            pass
        fscope = Scope("function", parent=scope if scope.kind != "class" else scope.parent, local_names=locs,
                       global_names=globs, nonlocal_names=nonlocs, fn_defs=nested, cls=cls)
        self.body(ctx, n.body, fscope, fid, 0)
        levels = [b["level"] for b in ctx.out["blocks"] if b["kind"] not in ("function", "class") and b["span"]["line"] >= n.lineno and b["span"]["endLine"] <= (n.end_lineno or n.lineno)]
        info["maxLevel"] = max([lv for lv in levels if lv > 0] or [0])

    def klass(self, ctx, n, scope, fn):
        e = [ev("pure", "define.class", f"defines class {n.name}")]
        for b in n.bases:
            e += self.expr(ctx, b, scope, fn)
        for d in n.decorator_list:
            e += self.expr(ctx, d, scope, fn)
        he = self.header_end(n)
        self.add_statement(ctx, n, "ClassDef", e, fn, he)
        self.add_block(ctx, n, "class", f"class {n.name}", 0, he, n.body)
        cscope = Scope("class", parent=scope, cls=n.name)
        self.body(ctx, n.body, cscope, fn, 0)

    # ---------- writes ----------
    def where(self, name, scope):
        """'local' | 'module' | 'outer' | 'global-decl' | 'nonlocal-decl' | 'undeclared'"""
        if scope.kind == "module":
            return "local"
        if name in scope.globals:
            return "global-decl"
        if name in scope.nonlocals:
            return "nonlocal-decl"
        if name in scope.locals:
            return "local"
        s = scope.parent
        while s is not None:
            if name in s.locals:
                return "module" if s.kind == "module" else "outer"
            s = s.parent
        return "undeclared"

    def write_target(self, tg, scope, fn, op):
        e = []
        if isinstance(tg, ast.Name):
            w = self.where(tg.id, scope)
            if w == "local":
                e.append(ev("pure", "assign.local", f"{op} local variable {tg.id}"))
            elif w == "global-decl":
                e.append(ev("mutation", "assign.global", f"{op} {tg.id}, declared global in this function"))
            elif w == "nonlocal-decl":
                e.append(ev("mutation", "assign.nonlocal", f"{op} {tg.id}, declared nonlocal (enclosing function's variable)"))
            else:
                e.append(ev("pure", "assign.local", f"{op} {tg.id} (Python makes it local here)"))
        elif isinstance(tg, ast.Attribute):
            e.append(ev("mutation", "assign.attribute", f"{op} {dotted(tg) or 'an attribute'}"))
        elif isinstance(tg, ast.Subscript):
            e.append(ev("mutation", "assign.subscript", f"{op} {dotted(tg.value) or 'a container'}[…]"))
        elif isinstance(tg, (ast.Tuple, ast.List)):
            for el in tg.elts:
                e += self.write_target(el, scope, fn, op)
        elif isinstance(tg, ast.Starred):
            e += self.write_target(tg.value, scope, fn, op)
        return e

    def expr_in_target(self, ctx, tg, scope, fn):
        """Calls inside a target, e.g. get_obj().x = 1 or d[key()] = v."""
        e = []
        if isinstance(tg, ast.Attribute):
            e += self.expr(ctx, tg.value, scope, fn) if not isinstance(tg.value, ast.Name) else []
        elif isinstance(tg, ast.Subscript):
            e += self.expr(ctx, tg.slice, scope, fn)
            if not isinstance(tg.value, ast.Name):
                e += self.expr(ctx, tg.value, scope, fn)
        elif isinstance(tg, (ast.Tuple, ast.List)):
            for el in tg.elts:
                e += self.expr_in_target(ctx, el, scope, fn)
        return e

    # ---------- calls ----------
    def resolve(self, name, ctx):
        head, _, rest = name.partition(".")
        if head in ctx.imports:
            target = ctx.imports[head]
            return f"{target}.{rest}" if rest else target
        return name

    def local_target(self, name, ctx, scope):
        head, _, rest = name.partition(".")
        # nested defs, innermost first
        s = scope
        while s is not None and not rest:
            if head in s.fn_defs:
                return s.fn_defs[head]
            s = s.parent
        if not rest and head in ctx.top_fns and self.where(head, scope) in ("module", "local", "undeclared") and not (scope.kind == "function" and head in scope.locals):
            return ctx.top_fns[head]
        if head in ("self", "cls") and scope.cls and rest and "." not in rest:
            return ctx.classes.get(scope.cls, {}).get(rest)
        if head in ctx.classes and rest and "." not in rest:
            return ctx.classes[head].get(rest)
        resolved = self.resolve(name, ctx)
        mod, _, fname = resolved.rpartition(".")
        if mod and mod in self.module_index:
            m = self.module_index[mod]
            if "." not in fname and fname in m.top_fns:
                return m.top_fns[fname]
            if fname in m.classes:
                return None
        # from .calc import add  -> "calc.add" / ".calc.add"
        mod2 = mod.lstrip(".")
        if mod2 and mod2 in self.module_index and fname in self.module_index[mod2].top_fns:
            return self.module_index[mod2].top_fns[fname]
        return None

    def call(self, ctx, n, scope, fn):
        e = self._call_evidence(ctx, n, scope, fn)
        rule = e["rule"]
        kind = "local" if rule == "call.local" else "unresolved" if rule == "call.unknown" else "known"
        site = {"name": dotted(n.func) or "(expression)", "line": n.lineno, "target": e.get("_target"), "kind": kind, "rule": rule}
        if fn and fn in self.fns:
            self.fns[fn]["callSites"].append(site)
        else:
            ctx.out["moduleCalls"].append(site)
        return e

    def _call_evidence(self, ctx, n, scope, fn):
        name = dotted(n.func)
        shown = (name or "(expression)") + "()"
        if fn and fn in self.fns:
            self.fns[fn]["calls"].append(name or "(expression)")
        if name:
            target = self.local_target(name, ctx, scope)
            if target:
                e = ev("pure", "call.local", f"calls {shown}, defined in the uploaded code")
                e["_target"] = target
                return e
            head = name.split(".")[0]
            shadowed = scope.kind != "module" and head in scope.locals and head not in ctx.imports
            resolved = self.resolve(name, ctx)
            r = self.rules
            if not shadowed:
                p = match_any(resolved, r["pure"]["certain"])
                if p:
                    return ev("pure", "call.pure-builtin", f"{shown} is a known pure built-in (rule \"{p}\")")
                p = match_any(resolved, r["io"]["certain"])
                if p:
                    return ev("io", "call.io", f"{shown} matches I/O rule \"{p}\"" + (f" (resolved to {resolved})" if resolved != name else ""))
                p = match_any(resolved, r["mutating_builtins"]["certain"])
                if p:
                    return ev("mutation", "call.mutating-builtin", f"{shown} changes an object's attributes")
                p = match_any(resolved, r["pure"].get("heuristic", []))
                if p:
                    return ev("pure", "call.pure-higher-order", f"{shown} is pure only if the function passed to it is", "heuristic")
            p = match_any(resolved, r["io"]["heuristic"])
            if p:
                return ev("io", "call.io-library", f"{shown} matches library I/O rule \"{p}\"", "heuristic")
        if isinstance(n.func, ast.Attribute):
            m = n.func.attr
            recv = dotted(n.func.value) or "an object"
            if m in self.rules["mutating_methods"]["heuristic"]:
                return ev("mutation", "call.mutating-method", f".{m}() usually changes {recv} in place", "heuristic")
            if m in self.rules["io_methods"]["heuristic"]:
                return ev("io", "call.io-method", f".{m}() is usually file, network or database I/O", "heuristic")
            if m in self.rules["pure"]["heuristic_methods"]:
                return ev("pure", "call.pure-method", f".{m}() usually returns a new value without side effects", "heuristic")
        return ev("unknown", "call.unknown", f"{shown} is not defined in the uploaded code and is not on a known list")

    def expr(self, ctx, n, scope, fn):
        e = []

        def visit(x):
            if isinstance(x, ast.Call):
                e.append(self.call(ctx, x, scope, fn))
            elif isinstance(x, (ast.Await, ast.Yield, ast.YieldFrom)):
                kind = {"Await": "await: pauses until the awaited task finishes", "Yield": "yield: pauses the generator", "YieldFrom": "yield from: delegates to another generator"}[type(x).__name__]
                e.append(ev("control", "control." + type(x).__name__.lower(), kind))
            elif isinstance(x, ast.NamedExpr):
                e.extend(self.write_target(x.target, scope, fn, "assigns (:=)"))
            elif isinstance(x, (ast.Attribute, ast.Name)) and isinstance(getattr(x, "ctx", None), ast.Load):
                nm = dotted(x)
                if nm:
                    res = self.resolve(nm, ctx)
                    p = match_any(res, self.rules["io_reads"]["certain"])
                    if p and not (isinstance(x, ast.Name) and scope.kind != "module" and x.id in scope.locals):
                        e.append(ev("io", "read.environment", f"reads {nm} (environment / process state)"))
                        return
            for c in ast.iter_child_nodes(x):
                if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    continue
                visit(c)

        visit(n)
        return e

    # ---------- summaries ----------
    def summarize(self, label, root, inner):
        branches = 0
        writes, calls = [], []

        def add(arr, v):
            if v and v not in arr:
                arr.append(v)

        def visit(x, top=False):
            nonlocal branches
            if not top and isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                return
            if isinstance(x, ast.If):
                is_chain = len(x.orelse) == 1 and isinstance(x.orelse[0], ast.If)
                branches += 1 if is_chain else 2
            elif isinstance(x, ast.IfExp):
                branches += 2
            elif isinstance(x, ast.ExceptHandler):
                branches += 1
            elif isinstance(x, ast.match_case) if hasattr(ast, "match_case") else False:
                branches += 1
            if isinstance(x, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                for tg in (x.targets if isinstance(x, ast.Assign) else [x.target]):
                    for t in (tg.elts if isinstance(tg, (ast.Tuple, ast.List)) else [tg]):
                        add(writes, dotted(t) if not isinstance(t, ast.Subscript) else (dotted(t.value) or "") + "[…]")
            if isinstance(x, ast.Call):
                nm = dotted(x.func)
                if nm:
                    add(calls, nm + "()")
            for c in ast.iter_child_nodes(x):
                visit(c)

        if isinstance(root, (ast.If, ast.Try)) or type(root).__name__ in ("TryStar", "Match"):
            visit(root, top=True)
        else:
            for i in inner:
                visit(i)
        parts = [label]
        if branches:
            parts.append(f"{branches} branch{'es' if branches != 1 else ''}")
        if writes:
            parts.append("writes " + ", ".join(writes[:3]) + (f" +{len(writes) - 3}" if len(writes) > 3 else ""))
        if calls:
            parts.append("calls " + ", ".join(calls[:3]) + (f" +{len(calls) - 3}" if len(calls) > 3 else ""))
        return " · ".join(parts)

    # ---------- interprocedural ----------
    def fn_role(self, fid):
        effects = [e for s in self.fn_statements.get(fid, []) for e in s["evidence"] if e["role"] in EFFECT_ROLES]
        return primary(effects) if effects else ("pure", "certain")

    def resolve_local_calls(self):
        for _ in range(20):
            changed = False
            for e, target in self.pending:
                callee = self.fns.get(target)
                if not callee:
                    continue
                role, cert = self.fn_role(target)
                detail = f"calls {callee['qualname']}(), defined in the uploaded code; that function's role is {role}"
                if (e["role"], e["certainty"], e["detail"]) != (role, cert, detail):
                    e["role"], e["certainty"], e["detail"] = role, cert, detail
                    changed = True
            if not changed:
                break
        for c in self.ctxs:
            for s in c.out["statements"]:
                s["role"], s["certainty"] = primary(s["evidence"])
        for fid, info in self.fns.items():
            info["role"] = self.fn_role(fid)[0]



# =====================================================================================
# Phase 5: scope-aware bindings (lens, brief §6.6) and file-local extra checks (§6.7).
# Same JSON shapes as model.ts (Binding, Finding, SecretSpan, DupWindow).
# Cross-file checks (unused functions, duplicates across files) are done in review/checks.ts.
# =====================================================================================
import hashlib
import io
import math
import re
import tokenize

SECRET_PATTERNS = [  # keep in step with src/analysis/secrets.ts
    ("secret.aws-key", "AWS access key id", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("secret.github-token", "GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b")),
    ("secret.slack-token", "Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("secret.stripe-key", "Stripe key", re.compile(r"\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b")),
    ("secret.google-key", "Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("secret.openai-key", "API key (sk-…)", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("secret.private-key", "private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("secret.jwt", "JSON web token", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("secret.url-credentials", "password inside a URL", re.compile(r"//[^/\s:@]+:[^/\s@]{3,}@")),
]
SECRET_NAME = re.compile(r"(secret|token|api[_-]?key|apikey|passw(or)?d|passwd|pwd|private[_-]?key|credential|access[_-]?key|auth[_-]?key|client[_-]?secret)", re.I)
FILE_EXT = re.compile(r"\.(js|mjs|cjs|py|json|ts|css|html|svelte|md|txt|png|svg)$", re.I)


def str_entropy(s):
    counts = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    return -sum((c / len(s)) * math.log2(c / len(s)) for c in counts.values())


def scan_secret(value, hint):
    for rule, label, rx in SECRET_PATTERNS:
        if rx.search(value):
            return rule, label, "certain"
    v = value.strip()
    if hint and SECRET_NAME.search(hint) and len(v) >= 8 and not re.search(r"\s", v) and not re.fullmatch(r"[A-Z][A-Z0-9_]*", v) and not re.match(r"(https?:)?//", v):
        return "secret.name-hint", f'string assigned to "{hint}"', "heuristic"
    if len(v) >= 20 and not re.search(r"\s", v) and re.search(r"[0-9]", v) and re.search(r"[A-Za-z]", v) and "://" not in v and v.count("/") < 3 and not FILE_EXT.search(v):
        is_hex = re.fullmatch(r"[0-9a-fA-F]+", v) is not None
        if (is_hex and len(v) >= 32 and str_entropy(v) >= 3) or (not is_hex and str_entropy(v) >= 4.2):
            return "secret.high-entropy", "long random-looking string", "heuristic"
    return None


def mask_value(v):
    return v[: min(4, len(v) // 4)] + "•" * min(12, max(4, len(v) - 4))


MIN_DUP_NODES = 20  # Python trees are more compact than Babel's (attribute names are not nodes), so 20 here ~ 25 in JS
SKIP_COUNT = (ast.expr_context, ast.operator, ast.boolop, ast.cmpop, ast.unaryop)


def dup_hash(stmts):
    names = {}
    out = []
    count = [0]

    def canon(s):
        if s not in names:
            names[s] = len(names)
        return "#" + str(names[s])

    def walk(n):
        if not isinstance(n, SKIP_COUNT):
            count[0] += 1
        tok = type(n).__name__
        if isinstance(n, ast.Name):
            tok += canon(n.id)
        elif isinstance(n, ast.arg):
            tok += canon(n.arg)
        elif isinstance(n, ast.Attribute):
            tok += canon(n.attr)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            tok += canon(n.name)
        out.append(tok + "(")
        if not isinstance(n, ast.Constant):
            for field, val in ast.iter_fields(n):
                if isinstance(val, ast.AST):
                    walk(val)
                elif isinstance(val, list):
                    for x in val:
                        if isinstance(x, ast.AST):
                            walk(x)
        out.append(")")

    for s in stmts:
        walk(s)
    if count[0] < MIN_DUP_NODES:
        return None
    return hashlib.sha1("".join(out).encode()).hexdigest()[:16]


class PyScope:
    def __init__(self, kind, node, parent, fn_id):
        self.kind = kind  # module | function | class | comp
        self.node = node
        self.parent = parent
        self.fn_id = fn_id  # innermost model function id (None at module level)
        self.bindings = {}
        self.globals = set()
        self.nonlocals = set()


class PyExtras:
    def __init__(self, analyzer, ctx, tree):
        self.a = analyzer
        self.ctx = ctx
        self.tree = tree
        self.lines = ctx.lines
        self.bindings = []
        self.findings = []
        self.secrets = []
        self.dups = []
        self.n = 0
        self.parents = {}
        for p in ast.walk(tree):
            for c in ast.iter_child_nodes(p):
                self.parents[c] = p
        t = ctx.text
        self.dynamic = re.search(r"\b(exec|eval|locals|globals|vars)\s*\(", t) is not None
        self.star = any(isinstance(n, ast.ImportFrom) and any(al.name == "*" for al in n.names) for n in ast.walk(tree))
        self.all_names = set()
        for n in tree.body:
            if isinstance(n, ast.Assign) and any(isinstance(tg, ast.Name) and tg.id == "__all__" for tg in n.targets) and isinstance(n.value, (ast.List, ast.Tuple)):
                self.all_names = {e.value for e in n.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)}

    # ---------- helpers ----------
    def chcol(self, line, bcol):
        """Python's col_offset counts UTF-8 bytes; the app needs string indices."""
        if line < 1 or line > len(self.lines):
            return bcol
        s = self.lines[line - 1]
        if s.isascii():
            return bcol
        return len(s.encode("utf-8")[:bcol].decode("utf-8", "ignore").encode("utf-16-le")) // 2

    def ucols(self, line, start_char, text_len):
        s = self.lines[line - 1] if 0 < line <= len(self.lines) else ""
        prefix = s[:start_char]
        u = len(prefix.encode("utf-16-le")) // 2
        return u, u + len(s[start_char:start_char + text_len].encode("utf-16-le")) // 2

    def name_ref(self, line, name, after_char=0):
        """Find `name` as a whole word on a line at or after a char index; returns (col, endCol) in UTF-16 units."""
        s = self.lines[line - 1] if 0 < line <= len(self.lines) else ""
        m = re.compile(r"(?<![\w])" + re.escape(name) + r"(?![\w])").search(s, after_char)
        if not m:
            return None
        return self.ucols(line, m.start(), len(name))

    def fid(self):
        i = f"{self.ctx.idx}:f:{self.n}"
        self.n += 1
        return i

    def add(self, check, rule, line, end_line, fn, detail, certainty, source="syntax tree"):
        self.findings.append({"id": self.fid(), "check": check, "rule": rule, "line": line, "endLine": end_line, "fn": fn,
                              "detail": detail, "certainty": certainty, "source": source})

    def fn_of(self, node):
        p = node
        while p is not None:
            f = self.a.node_fn.get(p)
            if f:
                return f
            p = self.parents.get(p)
        return None

    # ---------- scopes ----------
    def run(self):
        mod = PyScope("module", self.tree, None, None)
        self.scopes = [mod]
        self.declare(mod, self.tree.body)
        self.resolve_all()
        self.emit_bindings()
        self.checks()
        out = self.ctx.out
        out["bindings"] = self.bindings
        out["findings"] = self.findings
        out["secrets"] = self.secrets
        out["dupWindows"] = self.dups

    def bind(self, scope, name, kind, line, col, end_col, node=None, decl=True):
        b = scope.bindings.get(name)
        if b is None:
            b = {"name": name, "kind": kind, "scope": scope, "refs": [], "node": node, "fnTarget": None, "from": None, "tuple": False}
            scope.bindings[name] = b
        if node is not None and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            b["kind"] = "function"
            b["fnTarget"] = self.a.node_fn.get(node)
        if line:
            b["refs"].append({"line": line, "col": col, "endCol": end_col, "access": "decl" if decl and not b["refs"] else "write"})
        return b

    def declare(self, scope, body_nodes, extra=()):
        """Pass A: every name bound in this scope (Python: assigned anywhere => local)."""
        pending_children = []

        def visit(n):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                for d in n.decorator_list:
                    visit(d)
                if not isinstance(n, ast.ClassDef):
                    for dflt in n.args.defaults + [d for d in n.args.kw_defaults if d is not None]:
                        visit(dflt)
                else:
                    for b in n.bases + [k.value for k in n.keywords]:
                        visit(b)
                kw = "class " if isinstance(n, ast.ClassDef) else ("async def " if isinstance(n, ast.AsyncFunctionDef) else "def ")
                line = n.lineno
                s = self.lines[line - 1] if 0 < line <= len(self.lines) else ""
                at = s.find(kw)
                pos = self.name_ref(line, n.name, at + len(kw) if at >= 0 else 0)
                if n.name not in scope.globals and n.name not in scope.nonlocals:
                    self.bind(scope, n.name, "class" if isinstance(n, ast.ClassDef) else "function", line, pos[0] if pos else 0, pos[1] if pos else 0, n)
                pending_children.append(n)
                return
            if isinstance(n, ast.Lambda):
                for dflt in n.args.defaults + [d for d in n.args.kw_defaults if d is not None]:
                    visit(dflt)
                pending_children.append(n)
                return
            if isinstance(n, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                visit(n.generators[0].iter)  # evaluated in the enclosing scope
                pending_children.append(n)
                return
            if isinstance(n, ast.Global):
                scope.globals.update(n.names)
            elif isinstance(n, ast.Nonlocal):
                scope.nonlocals.update(n.names)
            elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
                if n.id not in scope.globals and n.id not in scope.nonlocals:
                    b = self.bind(scope, n.id, "variable", 0, 0, 0)
                    par = self.parents.get(n)
                    if isinstance(par, (ast.Tuple, ast.List, ast.Starred)):
                        b["tuple"] = True
            elif isinstance(n, ast.NamedExpr) and isinstance(n.target, ast.Name):
                tgt = scope
                while tgt.kind == "comp" and tgt.parent is not None:  # walrus binds in the enclosing scope
                    tgt = tgt.parent
                self.bind(tgt, n.target.id, "variable", 0, 0, 0)
            elif isinstance(n, (ast.Import, ast.ImportFrom)):
                for al in n.names:
                    if al.name == "*":
                        continue
                    bound = al.asname or al.name.split(".")[0]
                    line = getattr(al, "lineno", n.lineno)
                    start = self.chcol(line, getattr(al, "col_offset", n.col_offset))
                    s = self.lines[line - 1] if 0 < line <= len(self.lines) else ""
                    after = s.find(" as ", start) + 4 if al.asname and s.find(" as ", start) >= 0 else start
                    pos = self.name_ref(line, bound, after)
                    b = self.bind(scope, bound, "import", line, pos[0] if pos else 0, pos[1] if pos else 0)
                    b["kind"] = "import"
                    b["importNode"] = n
                    b["from"] = self.import_from(n, al)
            elif isinstance(n, ast.ExceptHandler) and n.name:
                s = self.lines[n.lineno - 1] if 0 < n.lineno <= len(self.lines) else ""
                pos = self.name_ref(n.lineno, n.name, max(0, s.find(" as ")))
                b = self.bind(scope, n.name, "variable", n.lineno, pos[0] if pos else 0, pos[1] if pos else 0)
                b["except"] = True
            for c in ast.iter_child_nodes(n):
                visit(c)

        for x in extra:
            visit(x)
        for st in body_nodes:
            visit(st)
        # child scopes
        for ch in pending_children:
            if isinstance(ch, ast.ClassDef):
                cs = PyScope("class", ch, scope, scope.fn_id)
                self.scopes.append(cs)
                self.declare(cs, ch.body)
            elif isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                fs = PyScope("function", ch, scope, self.a.node_fn.get(ch) or scope.fn_id)
                self.scopes.append(fs)
                a = ch.args
                for arg in a.posonlyargs + a.args + a.kwonlyargs + ([a.vararg] if a.vararg else []) + ([a.kwarg] if a.kwarg else []):
                    c0 = self.chcol(arg.lineno, arg.col_offset)
                    self.bind(fs, arg.arg, "param", arg.lineno, *self.ucols(arg.lineno, self.char_of(arg.lineno, c0), len(arg.arg)))
                if isinstance(ch, ast.Lambda):
                    self.declare(fs, [], [ch.body])
                else:
                    self.declare(fs, ch.body)
            else:  # comprehension
                cs = PyScope("comp", ch, scope, scope.fn_id)
                self.scopes.append(cs)
                parts = []
                for i, g in enumerate(ch.generators):
                    parts.append(g.target)
                    if i:
                        parts.append(g.iter)
                    parts.extend(g.ifs)
                parts.extend([ch.key, ch.value] if isinstance(ch, ast.DictComp) else [ch.elt])
                self.declare(cs, [], parts)

    def char_of(self, line, ucol):
        """UTF-16 column -> char index (for ucols)."""
        s = self.lines[line - 1] if 0 < line <= len(self.lines) else ""
        if s.isascii():
            return ucol
        acc = 0
        for i, ch in enumerate(s):
            if acc >= ucol:
                return i
            acc += 2 if ord(ch) > 0xFFFF else 1
        return len(s)

    def scope_of_node(self, node):
        """Innermost scope whose own code contains this node."""
        p = self.parents.get(node)
        child = node
        while p is not None:
            if isinstance(p, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                # defaults and decorators belong to the outer scope
                if child in p.args.defaults or child in p.args.kw_defaults or child in getattr(p, "decorator_list", []) or child is p.args:
                    pass
                else:
                    return self.scope_map[p]
            elif isinstance(p, ast.ClassDef):
                if child in p.body:
                    return self.scope_map[p]
            elif isinstance(p, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                if child is not p.generators[0].iter:
                    return self.scope_map[p]
            elif isinstance(p, ast.comprehension):
                par = self.parents.get(p)
                if not (child is p.iter and par is not None and par.generators[0] is p):
                    return self.scope_map[par]
                child = par
                p = self.parents.get(par)
                continue
            child = p
            p = self.parents.get(p)
        return self.scopes[0]

    def lookup(self, scope, name):
        s = scope
        if name in s.globals:
            return self.scopes[0].bindings.get(name)
        first = True
        while s is not None:
            if name in s.globals:
                return self.scopes[0].bindings.get(name)
            if (first or s.kind != "class") and name in s.bindings and name not in s.nonlocals:
                return s.bindings[name]
            first = False
            s = s.parent
        return None

    def resolve_all(self):
        """Pass B: every Name read/write is attached to the binding it refers to."""
        self.scope_map = {s.node: s for s in self.scopes}
        for n in ast.walk(self.tree):
            if not isinstance(n, ast.Name):
                continue
            scope = self.scope_of_node(n)
            b = self.lookup(scope, n.id)
            if b is None:
                continue
            par = self.parents.get(n)
            if isinstance(n.ctx, ast.Load):
                access = "read"
            elif isinstance(par, ast.AugAssign) and par.target is n:
                access = "readwrite"
            else:
                access = "write"
            col = self.chcol(n.lineno, n.col_offset)
            ref = {"line": n.lineno, "col": col, "endCol": col + len(n.id.encode("utf-16-le")) // 2, "access": access}
            if not any(r["line"] == ref["line"] and r["col"] == ref["col"] for r in b["refs"]):
                if access == "write" and not b["refs"]:
                    ref["access"] = "decl"
                b["refs"].append(ref)
        # names used only inside __all__ strings count as exported, not read

    def import_from(self, n, al):
        if isinstance(n, ast.Import):
            mod, name = al.name, "*"
        else:
            mod = n.module or ""
            if n.level:
                base = self.ctx.path.split("/")[:-1]
                base = base[: len(base) - (n.level - 1)] if n.level > 1 else base
                mod = ".".join([p for p in base if p] + ([mod] if mod else []))
            name = al.name
        tgt = self.a.module_index.get(mod) or (self.a.module_index.get(mod.split(".")[-1]) if mod else None)
        if tgt is None and isinstance(n, ast.ImportFrom):  # `from pkg import module`
            sub = self.a.module_index.get((mod + "." if mod else "") + al.name)
            if sub is not None:
                return {"path": sub.path, "name": "*"}
        return {"path": tgt.path if tgt is not None else None, "name": name}

    def emit_bindings(self):
        for s in self.scopes:
            for name, b in s.bindings.items():
                refs = sorted(b["refs"], key=lambda r: (r["line"], r["col"]))
                if not refs:
                    continue
                cert, note = "certain", None
                if self.dynamic:
                    cert, note = "heuristic", "the file uses exec/eval/locals/globals/vars, so names can be reached in ways the syntax tree does not show"
                elif s.kind in ("class", "comp"):
                    cert, note = "heuristic", "class and comprehension scopes follow special lookup rules"
                elif self.star and s.kind == "module":
                    cert, note = "heuristic", "the file has `from … import *`, which can bring in names the syntax tree does not show"
                bid = f"{self.ctx.idx}:v:{len(self.bindings)}"
                out = {"id": bid, "name": name, "kind": b["kind"], "fn": s.fn_id, "refs": refs, "certainty": cert}
                if b["fnTarget"]:
                    out["fnTarget"] = b["fnTarget"]
                if s.kind == "module" and name in self.all_names:
                    out["exported"] = True
                if b["from"]:
                    out["from"] = b["from"]
                if note:
                    out["note"] = note
                b["out"] = out
                self.bindings.append(out)

    # ---------- checks ----------
    def checks(self):
        ctx = self.ctx
        is_init = ctx.path.endswith("__init__.py")
        for s in self.scopes:
            for name, b in s.bindings.items():
                o = b.get("out")
                if not o:
                    continue
                reads = sum(1 for r in o["refs"] if r["access"] in ("read", "readwrite"))
                if reads or name.startswith("_") or o.get("exported"):
                    continue
                line = o["refs"][0]["line"]
                if b["kind"] == "import":
                    node = b.get("importNode")
                    if isinstance(node, ast.ImportFrom) and node.module == "__future__":
                        continue
                    in_try = any(isinstance(p, ast.Try) for p in self.ancestors(node))
                    cert, extra = o["certainty"], ""
                    if is_init and s.kind == "module":
                        cert, extra = "heuristic", " (in __init__.py, imports are often re-exports)"
                    elif in_try:
                        cert, extra = "heuristic", " (inside try, it may only be checking that the module exists)"
                    elif o.get("note"):
                        extra = f" ({o['note']})"
                    self.add("unused-import", "unused.import", line, line, s.fn_id, f'"{name}" is imported but never used{extra}', cert)
                elif b["kind"] == "variable" and s.kind == "function" and not b.get("except"):
                    writes = len(o["refs"])
                    what = "is assigned but never read" if writes else "is declared but never used"
                    if b["tuple"]:
                        self.add("unused-variable", "unused.variable", line, line, s.fn_id, f'"{name}" {what} (it may be there to unpack a tuple; name it _ to say so)', "heuristic")
                    else:
                        self.add("unused-variable", "unused.variable", line, line, s.fn_id, f'"{name}" {what}' + (f" ({o['note']})" if o.get("note") else ""), o["certainty"])
        docstrings = set()
        for n in ast.walk(self.tree):
            if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant):
                docstrings.add(n.body[0].value)
        for n in ast.walk(self.tree):
            if isinstance(n, ast.ExceptHandler):
                swallow = len(n.body) == 1 and isinstance(n.body[0], ast.Pass)
                tail = " and the handler only says pass, so it is silently ignored" if swallow else ""
                if n.type is None:
                    self.add("broad-catch", "catch.bare", n.lineno, n.end_lineno or n.lineno, self.fn_of(n), "bare `except:` catches everything, even KeyboardInterrupt and SystemExit" + tail, "certain")
                else:
                    names = [dotted(t) for t in (n.type.elts if isinstance(n.type, ast.Tuple) else [n.type])]
                    broad = [x for x in names if x in ("Exception", "BaseException")]
                    if broad:
                        self.add("broad-catch", "catch.broad", n.lineno, n.end_lineno or n.lineno, self.fn_of(n), f"`except {broad[0]}` catches every error, including bugs" + tail, "certain")
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                fid = self.a.node_fn.get(n)
                params = n.args.posonlyargs + n.args.args
                pairs = list(zip(params[len(params) - len(n.args.defaults):], n.args.defaults)) + [(a, d) for a, d in zip(n.args.kwonlyargs, n.args.kw_defaults) if d is not None]
                for arg, d in pairs:
                    if isinstance(d, (ast.List, ast.Dict, ast.Set, ast.ListComp, ast.DictComp, ast.SetComp)):
                        self.add("mutable-default", "default.mutable", d.lineno, d.end_lineno or d.lineno, fid, f"`{arg.arg}` defaults to a {type(d).__name__.lower().replace('comp', ' comprehension')}, which is created once and shared by every call", "certain")
                    elif isinstance(d, ast.Call) and isinstance(d.func, ast.Name) and d.func.id in ("list", "dict", "set", "bytearray"):
                        self.add("mutable-default", "default.mutable-call", d.lineno, d.end_lineno or d.lineno, fid, f"`{arg.arg}` defaults to {d.func.id}(), which is created once and shared by every call", "certain")
                    elif isinstance(d, ast.Call) and dotted(d.func) in ("defaultdict", "collections.defaultdict", "deque", "collections.deque", "OrderedDict", "collections.OrderedDict", "Counter", "collections.Counter"):
                        self.add("mutable-default", "default.mutable-call", d.lineno, d.end_lineno or d.lineno, fid, f"`{arg.arg}` defaults to {dotted(d.func)}(), which is created once and shared by every call", "heuristic")
                self.placeholder(n, fid)
            elif isinstance(n, ast.Constant) and isinstance(n.value, str) and n not in docstrings:
                par = self.parents.get(n)
                if isinstance(par, ast.JoinedStr):
                    continue
                self.secret(n, n.value)
        self.todos()
        self.windows()
        for u in ctx.out.get("unreachable", []):
            pass  # unreachable findings are added in review/checks.ts for both languages

    def ancestors(self, node):
        p = self.parents.get(node)
        while p is not None:
            yield p
            p = self.parents.get(p)

    def placeholder(self, n, fid):
        if any(dotted(d) in ("abstractmethod", "abc.abstractmethod", "overload", "typing.overload") for d in n.decorator_list):
            return
        body = n.body
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
            body = body[1:]
        if not body:
            return  # only a docstring: a common, deliberate stub; not flagged
        if len(body) != 1:
            return
        b = body[0]
        qual = self.a.fns.get(fid, {}).get("qualname", n.name) if fid else n.name
        if isinstance(b, ast.Pass):
            self.add("placeholder", "placeholder.pass", n.lineno, n.end_lineno or n.lineno, fid, f"{qual}() only says pass", "certain")
        elif isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and b.value.value is Ellipsis:
            self.add("placeholder", "placeholder.ellipsis", n.lineno, n.end_lineno or n.lineno, fid, f"{qual}() body is only ...", "certain")
        elif isinstance(b, ast.Raise) and b.exc is not None and dotted(b.exc.func if isinstance(b.exc, ast.Call) else b.exc) == "NotImplementedError":
            self.add("placeholder", "placeholder.not-implemented", n.lineno, n.end_lineno or n.lineno, fid, f"{qual}() only raises NotImplementedError", "certain")

    def hint(self, n):
        par = self.parents.get(n)
        if isinstance(par, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            tgts = par.targets if isinstance(par, ast.Assign) else [par.target]
            for t in tgts:
                d = dotted(t)
                if d:
                    return d.split(".")[-1]
        if isinstance(par, ast.keyword) and par.arg:
            return par.arg
        if isinstance(par, ast.Dict):
            for k, v in zip(par.keys, par.values):
                if v is n and isinstance(k, ast.Constant) and isinstance(k.value, str):
                    return k.value
        if isinstance(par, ast.arguments):
            pos = par.posonlyargs + par.args
            for a, d in zip(pos[len(pos) - len(par.defaults):], par.defaults):
                if d is n:
                    return a.arg
            for a, d in zip(par.kwonlyargs, par.kw_defaults):
                if d is n:
                    return a.arg
        return None

    def secret(self, n, value):
        if not value:
            return
        hit = scan_secret(value, self.hint(n))
        if not hit:
            return
        rule, label, cert = hit
        line, end_line = n.lineno, n.end_lineno or n.lineno
        sc = self.chcol(line, n.col_offset)
        ec = self.chcol(end_line, n.end_col_offset or 0)
        s = self.lines[line - 1]
        m = re.match(r"[rRbBuU]*('''|\"\"\"|'|\")", s[self.char_of(line, sc):])
        q = len(m.group(0)) if m else 1
        ql = len(m.group(1)) if m else 1
        self.secrets.append({"line": line, "col": sc + q, "endLine": end_line, "endCol": max(sc + q, ec - ql) if end_line == line else ec - ql})
        self.add("secret", rule, line, end_line, self.fn_of(n), f'possible {label}: "{mask_value(value)}" ({len(value)} characters, masked)', cert)

    def todos(self):
        try:
            toks = list(tokenize.generate_tokens(io.StringIO(self.ctx.text).readline))
        except Exception:
            return
        for t in toks:
            if t.type == tokenize.COMMENT:
                m = re.search(r"\b(TODO|FIXME|XXX|HACK)\b[:\s-]*(.*)", t.string)
                if m:
                    line = t.start[0]
                    fn = None
                    best = None
                    for f in self.ctx.out["functions"]:
                        if f["span"]["line"] <= line <= f["span"]["endLine"] and (best is None or f["span"]["line"] > best["span"]["line"]):
                            best = f
                    fn = best["id"] if best else None
                    text = m.group(2).strip()[:80]
                    self.add("todo", "comment." + m.group(1).lower(), line, line, fn, f"{m.group(1)} comment" + (f": {text}" if text else ""), "certain", "comments")

    def windows(self):
        lists = []
        for n in ast.walk(self.tree):
            for field in ("body", "orelse", "finalbody"):
                v = getattr(n, field, None)
                if isinstance(v, list) and v and isinstance(v[0], ast.stmt):
                    lists.append((n, v))
            if isinstance(n, ast.Try):
                for h in n.handlers:
                    pass  # handlers have their own .body, visited by ast.walk
        for owner, stmts in lists:
            stmts = [s for s in stmts if not isinstance(s, (ast.Import, ast.ImportFrom))]
            fn = self.a.node_fn.get(owner) or self.fn_of(owner)
            for i in range(len(stmts)):
                for j in range(i + 1, len(stmts)):
                    lines = (stmts[j].end_lineno or stmts[j].lineno) - stmts[i].lineno + 1
                    if lines < 6:
                        continue
                    h = dup_hash(stmts[i:j + 1])
                    if not h:
                        if lines > 40:
                            break
                        continue
                    self.dups.append({"hash": h, "line": stmts[i].lineno, "endLine": stmts[j].end_lineno or stmts[j].lineno, "fn": fn})
                    break


def analyze_json(input_json):
    data = json.loads(input_json)
    return json.dumps(PyAnalyzer(data["rules"]).analyze(data["files"]))
