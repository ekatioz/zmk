#!/usr/bin/env python3
"""Local server for the display designer.

Serves this directory and lets the page write the design (layout.json) and the generated
firmware sources (../display-module/src/generated/) back into the repository.

    ./serve.py [--port 8765] [--no-open]

Only listens on 127.0.0.1 and only accepts saves from the page it serves itself.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAYOUT = HERE / "layout.json"
GENERATED = (HERE / ".." / "display-module" / "src" / "generated").resolve()
ALLOWED_FILES = {"dd_assets.c", "dd_layout_central.c", "dd_layout_peripheral.c"}
MAX_BODY = 16 * 1024 * 1024


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    # --- helpers -----------------------------------------------------------
    def _json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _same_origin(self) -> bool:
        port = self.server.server_address[1]
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in allowed_hosts:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in allowed_hosts}

    def end_headers(self):
        # Always serve fresh files while developing the designer itself.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # args[0] is not always a string (log_error passes an HTTPStatus)
        if "/api/" in str(args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # --- routes ------------------------------------------------------------
    def do_GET(self):
        if self.path == "/api/layout":
            if not self._same_origin():
                return self._json(403, {"error": "forbidden"})
            if not LAYOUT.exists():
                return self._json(404, {"error": "no layout.json yet"})
            return self._json(200, json.loads(LAYOUT.read_text(encoding="utf-8")))
        if self.path == "/favicon.ico":
            self.send_response(204)  # no icon, and no 404 in the log
            self.end_headers()
            return
        if self.path == "/" or self.path.startswith("/?"):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/save":
            return self._json(404, {"error": "not found"})
        if not self._same_origin():
            return self._json(403, {"error": "forbidden"})
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self._json(415, {"error": "expected application/json"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json(400, {"error": "bad Content-Length"})
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        try:
            payload = json.loads(self.rfile.read(length))
            design = payload["design"]
            files = payload["files"]
            if not isinstance(design, dict) or not isinstance(files, dict):
                raise ValueError("design/files must be objects")
            if set(files) != ALLOWED_FILES:
                raise ValueError(f"files must be exactly {sorted(ALLOWED_FILES)}")
            if not all(isinstance(v, str) for v in files.values()):
                raise ValueError("file contents must be strings")
        except (KeyError, ValueError) as e:
            return self._json(400, {"error": str(e)})

        write_atomic(LAYOUT, json.dumps(design, separators=(",", ":")) + "\n")
        for name, content in files.items():
            write_atomic(GENERATED / name, content)
        self._json(200, {"ok": True, "written": ["layout.json", *sorted(files)]})


def open_browser(url: str) -> None:
    # The browser inherits our terminal, so its own log noise (e.g. Chromium zygote errors)
    # would end up in the server output. Start it detached from stdout/stderr where we can.
    opener = shutil.which("xdg-open")
    if opener:
        try:
            subprocess.Popen(
                [opener, url],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            return
        except OSError:
            pass
    webbrowser.open(url)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true", help="do not open the browser")
    args = ap.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"display designer: {url}   (Ctrl+C to stop)")
    if not args.no_open:
        threading.Timer(0.4, lambda: open_browser(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
