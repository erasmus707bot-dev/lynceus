#!/usr/bin/env python3
"""Spike servers: app on 127.0.0.1:8000 (static files), sink on 127.0.0.1:8001 (logs every hit).
Usage: python3 serve.py [app_port] [sink_port]"""
import http.server, socketserver, sys, threading, os, json, time
APP = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
SINK = int(sys.argv[2]) if len(sys.argv) > 2 else 8001
ROOT = os.path.dirname(os.path.abspath(__file__))
HITS = os.path.join(ROOT, 'sink-hits.jsonl')

class App(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.whl': 'application/zip'}
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass

class Sink(http.server.BaseHTTPRequestHandler):
    def _hit(self):
        with open(HITS, 'a') as f: f.write(json.dumps({'t': time.time(), 'method': self.command, 'path': self.path}) + '\n')
        self.send_response(200); self.send_header('Access-Control-Allow-Origin', '*'); self.end_headers(); self.wfile.write(b'leaked')
    do_GET = do_POST = do_OPTIONS = _hit
    def log_message(self, *a): pass

class T(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
s1 = T(('127.0.0.1', APP), App); s2 = T(('127.0.0.1', SINK), Sink)
threading.Thread(target=s2.serve_forever, daemon=True).start()
print(f'app http://127.0.0.1:{APP}/  sink http://127.0.0.1:{SINK}/ (hits -> sink-hits.jsonl)', flush=True)
s1.serve_forever()
