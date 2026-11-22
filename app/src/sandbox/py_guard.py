# Lynceus Python sandbox guard (brief §5), proven in Phase 0.
# Installed BEFORE any user code is imported. Blocks the modules that reach JavaScript or the
# network (js, pyodide.*, micropip) and makes socket / urllib / http.client raise a clear error.
# This is a second layer: the JS network stubs and the page CSP still apply underneath.
import sys

_LYNCEUS_BLOCK = ("js", "pyodide", "_pyodide", "pyodide_js", "micropip")


def _lynceus_blocked(name):
    return name.split(".")[0] in _LYNCEUS_BLOCK


class _LynceusImportBlock:
    def find_spec(self, name, path=None, target=None):
        if _lynceus_blocked(name):
            raise ImportError(f"network blocked by Lynceus: import {name}")
        return None


def install_guard():
    for k in [k for k in sys.modules if _lynceus_blocked(k)]:
        del sys.modules[k]
    sys.meta_path.insert(0, _LynceusImportBlock())

    def _net(*a, **k):
        raise OSError("network blocked by Lynceus")

    import socket
    import urllib.request
    import http.client

    class _Sock:
        def __init__(self, *a, **k):
            _net()

    socket.socket = _Sock
    socket.create_connection = _net
    socket.getaddrinfo = _net
    socket.socketpair = _net
    urllib.request.urlopen = _net
    urllib.request.OpenerDirector.open = _net
    http.client.HTTPConnection.connect = _net
    http.client.HTTPSConnection.connect = _net
