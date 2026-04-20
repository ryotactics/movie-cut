#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, HTTPServer

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        super().end_headers()
    def log_message(self, format, *args):
        pass  # suppress request logs

HTTPServer(('', 8765), Handler).serve_forever()
