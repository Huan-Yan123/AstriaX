"""Isolated WebUI fixture for native WebView2/IPC boundary verification."""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(sys.argv[1])
page = b"""<!doctype html><meta charset="utf-8"><h1>Upstream fixture</h1>
<script>
const mark = name => fetch('/' + name);
const escaped = () => window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
if (!window.__TAURI_INTERNALS__) mark('missing').then(() => mark('denied')).then(escaped);
else window.__TAURI_INTERNALS__.invoke('launcher_request', {channel:'config:get',payload:null})
  .then(() => mark('unsafe'), () => mark('denied'))
  .then(escaped);
</script>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/denied', '/unsafe', '/missing'):
            (root / ('remote-' + self.path[1:] + '.txt')).write_text('observed', encoding='utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
(root / 'server.json').write_text(json.dumps({'port': server.server_port}), encoding='utf-8')
server.serve_forever()
