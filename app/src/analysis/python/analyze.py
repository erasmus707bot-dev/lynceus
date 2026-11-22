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
        self.out = {"path": path, "lang": "python", "ok": True, "statements": [], "blocks": [], "functions": []}

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
        for s in stmts:
            self.statement(ctx, s, scope, fn, level)

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
        info = {"id": fid, "name": n.name, "qualname": qual, "span": span(n), "params": params, "calls": [], "maxLevel": 0, "role": "pure"}
        self.fns[fid] = info
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


def analyze_json(input_json):
    data = json.loads(input_json)
    return json.dumps(PyAnalyzer(data["rules"]).analyze(data["files"]))
