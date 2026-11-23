# Lynceus Python test runner (brief §6.3): pytest + coverage.py inside Pyodide, one coverage
# context per test (switched by the plugin below), so every line knows which tests ran it.
# Events go to the page as single JSON lines on the real stderr, prefixed with a per-run nonce.
import sys, os, json, re


def lynceus_run(cfg_json):
    cfg = json.loads(cfg_json)
    proj, nonce = cfg["proj"], cfg["nonce"]
    err = sys.__stderr__

    def emit(ev):
        err.write(nonce + json.dumps(ev) + "\n")
        err.flush()

    os.environ["COVERAGE_CORE"] = "pytrace"          # the C tracer isn't available in Pyodide
    os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    import coverage
    import pytest

    install_guard()  # from py_guard.py: nothing after this line can reach JS or the network

    def tail(s, n=2000):
        return s if len(s) <= n else "…" + s[-n:]

    def explain(text):
        m = re.search(r"No module named '([\w.]+)'", text or "")
        if m:
            name = m.group(1)
            local = os.path.exists(os.path.join(proj, name.split(".")[0] + ".py")) or os.path.isdir(os.path.join(proj, name.split(".")[0]))
            if not local:
                if cfg.get("packagesMode"):
                    return (f"Missing package '{name.split('.')[0]}'. Package downloads are on: check the names "
                            "under \"Package downloads\" on the Tests tab, press the download button, then run the tests again.\n\n")
                return (f"Missing package '{name.split('.')[0]}'. Package downloads are off, so only your uploaded "
                        "files and Python's standard library are available. You can turn downloads on in the Tests tab.\n\n")
        return ""

    def split(nodeid):
        f, _, rest = nodeid.partition("::")
        return f, (rest.replace("::", " › ") or "(module)")

    cov = coverage.Coverage(data_file=None, source=[proj], config_file=False, branch=False)
    results = {}

    class Plugin:
        def pytest_collection_modifyitems(self, session, config, items):
            emit({"type": "collected", "tests": [
                {"id": it.nodeid, "file": split(it.nodeid)[0], "name": split(it.nodeid)[1], "lang": "python"} for it in items]})

        def pytest_collectreport(self, report):
            if report.failed:
                text = report.longreprtext or ""
                f = report.nodeid or "(collection)"
                r = {"id": f + "::(load)", "file": f, "name": "(could not load test file)", "lang": "python",
                     "outcome": "error", "message": tail(explain(text) + "Could not load the test file, so none of its tests ran.\n\n" + text)}
                emit({"type": "collected", "tests": [{k: r[k] for k in ("id", "file", "name", "lang")}], "append": True})
                emit({"type": "result", "result": r})

        def pytest_runtest_logstart(self, nodeid, location):
            cov.switch_context(nodeid)
            f, name = split(nodeid)
            results[nodeid] = {"id": nodeid, "file": f, "name": name, "lang": "python", "outcome": "passed", "message": "", "ms": 0}
            emit({"type": "start", "id": nodeid})

        def pytest_runtest_logreport(self, report):
            r = results.get(report.nodeid)
            if r is None:
                return
            r["ms"] += int(report.duration * 1000)
            out = "".join(s for _, s in getattr(report, "sections", []) if s)
            if out:
                r["output"] = tail(out)
            if report.skipped:
                if r["outcome"] == "passed":
                    reason = report.longrepr[2] if isinstance(report.longrepr, tuple) else str(report.longrepr or "")
                    if hasattr(report, "wasxfail"):
                        reason = "Expected to fail (xfail)" + (f": {report.wasxfail}" if report.wasxfail else "")
                    r["outcome"], r["message"] = "skipped", reason.replace("Skipped: ", "") or "Skipped."
            elif report.failed:
                text = report.longreprtext or ""
                if report.when == "call":
                    r["outcome"] = "failed"
                    r["message"] = tail(explain(text) + text)
                elif r["outcome"] in ("passed", "skipped"):
                    r["outcome"] = "error"
                    r["message"] = tail(explain(text) + f"Error in test {report.when} (fixture):\n\n" + text)
            elif report.when == "call" and hasattr(report, "wasxfail"):
                r["outcome"], r["message"] = "failed", "Marked xfail but passed (strict)."

        def pytest_runtest_logfinish(self, nodeid, location):
            cov.switch_context("")
            emit({"type": "result", "result": results[nodeid]})

    sys.path.insert(0, proj)
    os.chdir(proj)
    args = ["-q", "-p", "no:cacheprovider", "-p", "no:pastebin", "--capture=sys", "-o", "console_output_style=classic",
            "--rootdir", proj, "--import-mode=prepend"]
    for d in cfg["skip"]:
        args += ["--deselect", d]
    args += [os.path.join(proj, f) for f in cfg["testFiles"]]
    cov.start()
    try:
        rc = pytest.main(args, plugins=[Plugin()])
    finally:
        cov.stop()

    data = cov.get_data()
    measured = {os.path.realpath(f): f for f in data.measured_files()}
    coverage_out = {}
    for dirpath, dirs, fnames in os.walk(proj):
        dirs[:] = [d for d in dirs if d not in ("__pycache__",) and not d.startswith(".")]
        for fn in fnames:
            if not fn.endswith(".py"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, proj).replace(os.sep, "/")
            try:
                _, stmts, _, _, _ = cov.analysis2(full)
            except Exception:
                continue
            lines = {}
            mf = measured.get(os.path.realpath(full))
            if mf:
                for ln, ctxs in data.contexts_by_lineno(mf).items():
                    lines[str(ln)] = sorted(set(ctxs))
            coverage_out[rel] = {"statements": sorted(stmts), "lines": lines}
    notes = []
    if int(rc) == 5:
        notes.append("pytest found no tests to run.")
    emit({"type": "done", "coverage": coverage_out, "notes": notes})
