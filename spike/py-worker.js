// Sandbox worker for Python: self-hosted Pyodide + pytest + coverage.py (per-test contexts).
import { loadPyodide } from './vendor/pyodide/pyodide.mjs';
import { lockNetwork } from './guard.js';

const BASE = new URL('./', import.meta.url).href;

const HARNESS = String.raw`
import sys, os, json, io, contextlib
os.environ["COVERAGE_CORE"] = "pytrace"   # C tracer is unavailable in Pyodide

# ---- Lynceus import hook + network stubs (installed BEFORE user code) ----
_BLOCK = ("js", "pyodide", "_pyodide", "pyodide_js", "micropip")
def _blocked(n): return n.split(".")[0] in _BLOCK
class _LynceusBlock:
    def find_spec(self, name, path=None, target=None):
        if _blocked(name):
            raise ImportError(f"network blocked by Lynceus: import {name}")
        return None
for _k in [k for k in sys.modules if _blocked(k)]:
    del sys.modules[_k]
sys.meta_path.insert(0, _LynceusBlock())

def _net(*a, **k): raise OSError("network blocked by Lynceus")
import socket, urllib.request, http.client
class _Sock:
    def __init__(self, *a, **k): _net()
socket.socket = _Sock
socket.create_connection = _net
socket.getaddrinfo = _net
urllib.request.urlopen = _net
urllib.request.OpenerDirector.open = _net
http.client.HTTPConnection.connect = _net
http.client.HTTPSConnection.connect = _net

# ---- run pytest under coverage with a context per test function ----
import coverage, pytest
class _Collect:
    def __init__(self): self.results = []
    def pytest_runtest_logreport(self, report):
        if report.when == "call" or (report.when == "setup" and report.outcome != "passed"):
            self.results.append({"test": report.nodeid, "outcome": report.outcome,
                                 "message": (report.longreprtext or "")[-600:] if report.failed else ""})
    def pytest_collectreport(self, report):
        if report.failed:
            self.results.append({"test": report.nodeid, "outcome": "error", "message": (report.longreprtext or "")[-600:]})

cov = coverage.Coverage(data_file=None, source=[PROJ], config_file=False)
cov.set_option("run:dynamic_context", "test_function")
col = _Collect()
buf = io.StringIO()
sys.path.insert(0, PROJ)
cov.start()
with contextlib.redirect_stdout(buf):
    rc = pytest.main(["-q", "-p", "no:cacheprovider", "-s", PROJ], plugins=[col])
cov.stop()
data = cov.get_data()
per_file = {}
for f in data.measured_files():
    if os.path.basename(f).startswith("test_"): continue
    by_line = data.contexts_by_lineno(f)
    per_file[os.path.relpath(f, PROJ)] = {str(l): sorted(c for c in ctxs if c) for l, ctxs in sorted(by_line.items())}
analysis = {}
for f in data.measured_files():
    if os.path.basename(f).startswith("test_"): continue
    _, stmts, _, missing, _ = cov.analysis2(f)
    analysis[os.path.relpath(f, PROJ)] = {"statements": stmts, "missing": missing}
json.dumps({"rc": int(rc), "results": col.results, "contexts": per_file, "analysis": analysis,
            "core": cov.sys_info and dict(cov.sys_info()).get("core"),
            "stdout_tail": buf.getvalue()[-2500:]})
`;

self.onmessage = async (e) => {
  const t0 = performance.now();
  const { files, noguard } = e.data; // { "calc.py": "...", "test_calc.py": "..." }
  try {
    const py = await loadPyodide({ indexURL: BASE + 'vendor/pyodide/' });
    const tLoad = performance.now();
    // Install pure-Python wheels from our own origin (no micropip, no PyPI).
    const wheels = await (await fetch(BASE + 'vendor/wheels/manifest.json')).json();
    const site = py.runPython('import site; site.getsitepackages()[0]');
    for (const w of wheels) {
      const buf = new Uint8Array(await (await fetch(BASE + 'vendor/wheels/' + w)).arrayBuffer());
      py.FS.writeFile('/tmp/' + w, buf);
      py.runPython(`import zipfile; zipfile.ZipFile('/tmp/${w}').extractall('${site}')`);
    }
    const PROJ = '/home/pyodide/proj';
    py.FS.mkdirTree(PROJ);
    for (const [name, src] of Object.entries(files)) py.FS.writeFile(PROJ + '/' + name, src);
    const tPrep = performance.now();
    // Lock the network for everything that runs from here on.
    const guardReport = noguard ? ['GUARD DISABLED (test variant)'] : lockNetwork(self);
    py.globals.set('PROJ', PROJ);
    const out = JSON.parse(await py.runPythonAsync(HARNESS));
    out.timing = { loadMs: Math.round(tLoad - t0), prepMs: Math.round(tPrep - tLoad), runMs: Math.round(performance.now() - tPrep) };
    out.guardReport = guardReport;
    out.pyVersion = py.version;
    self.postMessage(out);
  } catch (err) {
    self.postMessage({ fatal: String(err && err.stack || err) });
  }
};
