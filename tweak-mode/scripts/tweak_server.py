#!/usr/bin/env python3
"""
Tweak mode server. Python 3 only, nothing to install.

Two modes:

  static     Serves a folder of .html files and adds the tweak panel to every page.
             python3 tweak_server.py --mode static --root ./site --port 4322

  collector  Only serves the panel script and receives saved tweaks. The project's own
             dev server renders the site; add this to its root layout, dev only:
             <script src="http://localhost:4322/__tweak/overlay.js" defer></script>
             python3 tweak_server.py --mode collector --root . --port 4322

Saved tweaks go to <root>/tweak-changes.json (or --out). Each save is merged into what's there:
per page, per element and per property, so saving again after a reload keeps the earlier tweaks.
Only pages on this computer (localhost, 127.0.0.1) can save.
"""
import argparse
import json
import os
import posixpath
import re
import socket
import sys
import tempfile
import threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse, quote

HERE = os.path.dirname(os.path.abspath(__file__))
OVERLAY = os.path.join(HERE, "overlay.js")
MAX_BODY = 2 * 1024 * 1024
LOCAL = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.I)
LOCK = threading.Lock()


def overlay_js(server_origin):
    with open(OVERLAY, "r", encoding="utf-8") as f:
        js = f.read()
    return "window.__TW_SERVER=%s;\n%s" % (json.dumps(server_origin), js)


def load(out):
    try:
        with open(out, "r", encoding="utf-8") as f:
            store = json.load(f)
        if isinstance(store, dict) and isinstance(store.get("pages"), dict):
            return store
    except Exception:
        pass
    return {"pages": {}}


def merge(store, payload):
    """Merge one save into the store. A change is one element (or group) on one page; its styles merge
    by property. `removed` lists properties the user put back, so they leave the file too."""
    n = 0
    for page in payload.get("pages", []):
        if not isinstance(page, dict):
            continue
        url = page.get("url") or "/"
        if url.endswith("/index.html"):
            url = url[: -len("index.html")]
        old = store["pages"].get(url) or {"url": url, "changes": []}
        by_key = {(c.get("scope"), c.get("selector")): c for c in old.get("changes", []) if isinstance(c, dict)}
        for ch in page.get("changes", []):
            if not isinstance(ch, dict):
                continue
            key = (ch.get("scope"), ch.get("selector"))
            prev = by_key.get(key)
            styles = {s.get("prop"): s for s in (prev or {}).get("styles", []) if isinstance(s, dict)}
            for prop in ch.get("removed", []) or []:
                styles.pop(prop, None)
            for s in ch.get("styles", []) or []:
                if not isinstance(s, dict) or not s.get("prop"):
                    continue
                if s["prop"] in styles and "before" in styles[s["prop"]]:
                    s = dict(s, before=styles[s["prop"]]["before"])  # keep the value from before the first tweak
                styles[s["prop"]] = s
            merged = dict(prev or {}, **{k: v for k, v in ch.items() if k not in ("styles", "removed")})
            merged["styles"] = list(styles.values())
            fonts = sorted(set((prev or {}).get("googleFonts") or []) | set(ch.get("googleFonts") or []))
            if fonts:
                merged["googleFonts"] = fonts
            if merged["styles"]:
                by_key[key] = merged
            else:
                by_key.pop(key, None)
        changes = list(by_key.values())
        if changes:
            store["pages"][url] = dict(old, url=url, title=page.get("title") or old.get("title", ""),
                                       savedAt=page.get("savedAt"), changes=changes)
            n += len(changes)
        else:
            store["pages"].pop(url, None)
    store["savedAt"] = datetime.now().isoformat(timespec="seconds")
    return n


def write_atomic(path, data):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tweak-", suffix=".json", dir=d)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


class Handler(SimpleHTTPRequestHandler):
    root = "."
    mode = "static"
    origin = ""
    out = ""

    def _cors(self):
        o = self.headers.get("Origin")
        if o and LOCAL.match(o):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        SimpleHTTPRequestHandler.end_headers(self)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _send(self, body, ctype, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _file_for(self, path):
        """Find the file the way static hosts do: /about -> about.html or about/index.html."""
        path = posixpath.normpath(unquote(path)).lstrip("/")
        full = os.path.realpath(os.path.join(self.root, path))
        if not (full == self.root or full.startswith(self.root + os.sep)):
            return None, False
        inside = lambda f: os.path.realpath(f).startswith(self.root + os.sep)
        if os.path.isdir(full):
            f = os.path.join(full, "index.html")
            return (f if not os.path.exists(f) or inside(f) else None), True
        if not os.path.exists(full) and os.path.isfile(full + ".html"):
            return (full + ".html" if inside(full + ".html") else None), False
        return full, False

    def translate_path(self, path):
        full, _ = self._file_for(urlparse(path).path)
        return full or os.path.join(self.root, "__forbidden__")

    def _foreign_host(self):
        if LOCAL_HOST.match(self.headers.get("Host") or ""):
            return False
        self.send_error(403, "Open this page as localhost")
        return True

    def do_GET(self):
        if self._foreign_host():
            return
        url = urlparse(self.path)
        path = url.path

        if path == "/__tweak/overlay.js":
            # In static mode the page and the panel share an origin, so saves go to "".
            origin = "" if self.mode == "static" else self.origin
            self._send(overlay_js(origin).encode("utf-8"), "application/javascript; charset=utf-8")
            return

        if path == "/__tweak/saved":
            # everything saved so far, so a reload shows it
            with LOCK:
                data = load(self.out)
            self._send(json.dumps(data).encode("utf-8"), "application/json")
            return

        if self.mode == "collector":
            self._send(b"Tweak mode is running. Load /__tweak/overlay.js on your app page.",
                       "text/plain; charset=utf-8")
            return

        full, is_dir = self._file_for(path)
        if full is None:
            self.send_error(403)
            return
        if is_dir and not path.endswith("/"):
            self.send_response(301)
            self.send_header("Location", quote(unquote(path)) + "/" + (("?" + url.query) if url.query else ""))
            self.end_headers()
            return
        if not os.path.isfile(full):
            nf = os.path.join(self.root, "404.html")
            if os.path.isfile(nf):
                return self._html(nf, 404)
            self.send_error(404)
            return
        if full.endswith((".html", ".htm")):
            return self._html(full, 200)
        return SimpleHTTPRequestHandler.do_GET(self)

    def _html(self, full, status):
        with open(full, "rb") as f:
            html = f.read()
        tag = b'<script src="/__tweak/overlay.js" defer></script>\n'
        # before the last </body>: an earlier one can sit in a comment or a script
        ends = list(re.finditer(rb"</body\s*>", html, re.I))
        html = html[: ends[-1].start()] + tag + html[ends[-1].start():] if ends else html + tag
        # keep the page's own encoding: say what its <meta charset> says, or nothing
        cs = re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', html[:2048], re.I)
        ctype = "text/html; charset=" + cs.group(1).decode("ascii", "ignore") if cs else "text/html"
        self._send(html, ctype, status)

    def do_POST(self):
        if self._foreign_host():
            return
        if urlparse(self.path).path != "/__tweak/save":
            self.send_error(404)
            return
        o = self.headers.get("Origin")
        if o and not LOCAL.match(o):
            self._send(b'{"ok":false,"error":"Only pages on this computer can save."}', "application/json", 403)
            return
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            self._send(b'{"ok":false}', "application/json", 415)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            self._send(b'{"ok":false}', "application/json", 413 if length > MAX_BODY else 400)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict) or not isinstance(payload.get("pages", []), list):
                raise ValueError
        except Exception:
            self._send(b'{"ok":false}', "application/json", 400)
            return
        with LOCK:
            store = load(self.out)
            n = merge(store, payload)
            write_atomic(self.out, store)
        self._send(json.dumps({"ok": True, "count": n}).encode(), "application/json")
        print("[%s] saved: %d tweaked element(s) on that page" % (datetime.now().strftime("%H:%M:%S"), n), flush=True)

    def log_message(self, *args):
        pass


def port_taken(port):
    # dev servers often listen on IPv6 only (::1), where binding 127.0.0.1 would still succeed
    for host in ("127.0.0.1", "::1"):
        fam = socket.AF_INET6 if ":" in host else socket.AF_INET
        try:
            with socket.socket(fam, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            pass
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["static", "collector"], default="static")
    ap.add_argument("--root", default=".",
                    help="static: the site folder. collector: the project root.")
    ap.add_argument("--out", default=None, help="where to save (default: <root>/tweak-changes.json)")
    ap.add_argument("--port", type=int, default=4322)
    args = ap.parse_args()

    Handler.root = os.path.realpath(args.root)
    Handler.mode = args.mode
    Handler.origin = "http://localhost:%d" % args.port
    Handler.out = os.path.abspath(args.out or os.path.join(Handler.root, "tweak-changes.json"))
    if not os.path.isdir(Handler.root):
        sys.exit("Not a folder: " + Handler.root)
    if port_taken(args.port):
        sys.exit("Port %d is taken. Run again with --port %d" % (args.port, args.port + 1))

    class Server6(ThreadingHTTPServer):
        address_family = socket.AF_INET6

    # listen on both 127.0.0.1 and ::1 (localhost can mean either), never on the network
    try:
        server4 = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        sys.exit("Port %d is taken. Run again with --port %d" % (args.port, args.port + 1))
    try:
        server6 = Server6(("::1", args.port), Handler) if socket.has_ipv6 else None
    except OSError:
        server6 = None

    if args.mode == "static":
        pages = sorted(
            os.path.relpath(os.path.join(dp, f), Handler.root).replace("\\", "/")
            for dp, _, fs in os.walk(Handler.root)
            if "node_modules" not in dp
            for f in fs if f.endswith((".html", ".htm"))
        )
        print("Tweak mode (static) at http://localhost:%d" % args.port)
        for p in pages[:25]:
            print("   http://localhost:%d/%s" % (args.port, p))
    else:
        print("Tweak mode (collector) at http://localhost:%d" % args.port)
        print("Panel script: http://localhost:%d/__tweak/overlay.js" % args.port)
    print("Saving to: %s" % Handler.out, flush=True)
    if server6:
        threading.Thread(target=server6.serve_forever, daemon=True).start()
    try:
        server4.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
