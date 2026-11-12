#!/usr/bin/env python3
"""
Copy Edit Mode - lets a user rewrite website copy directly on the rendered page.

Two modes:

  static     Serves a folder of .html files and injects the editing overlay.
             python3 copy_edit_server.py --mode static --root ./site --port 4321

  collector  Serves only the overlay script + a save endpoint, for apps that
             already have their own dev server (Next.js, Vite, CRA, Astro).
             python3 copy_edit_server.py --mode collector --root . --port 4321
             Then load http://localhost:4321/__ce_overlay.js on the app page.

Edits are written to <root>/copy-changes.json. This script never modifies
source files - Claude applies the changes.

Standard library only.
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
from urllib.parse import quote, unquote, urlparse

MAX_BODY = 2 * 1024 * 1024
LOCAL = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.I)
LOCK = threading.Lock()

CSS = """
html.__ce-editing [data-ce-id]{outline:1px dashed rgba(99,102,241,.45);outline-offset:2px;border-radius:2px;cursor:text;}
html.__ce-editing [data-ce-id]:hover{outline:1px solid #6366f1;background:rgba(99,102,241,.07);}
html.__ce-editing [data-ce-id]:focus{outline:2px solid #6366f1;background:rgba(99,102,241,.10);}
[data-ce-dirty="1"]{outline:2px solid #f59e0b !important;background:rgba(245,158,11,.10) !important;}
#__ce-toggle{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1f2937;cursor:pointer;}
#__ce-toggle .sw{width:38px;height:22px;border-radius:99px;background:#374151;position:relative;transition:background .15s;flex:none;}
#__ce-toggle .sw i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:99px;background:#fff;transition:left .15s;}
#__ce-toggle.on .sw{background:#6366f1;}
#__ce-toggle.on .sw i{left:19px;}
#__ce-toggle .lbl{font-weight:600;}
#__ce-toggle .hint{color:#9ca3af;font-size:11px;margin-left:auto;text-align:right;line-height:1.3;}
#__ce-bar{position:fixed;z-index:2147483647;right:16px;bottom:16px;width:300px;overflow:hidden;border-radius:12px;
  font:13px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#111827;color:#f9fafb;
  box-shadow:0 10px 30px rgba(0,0,0,.35);}
#__ce-bar header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0b1220;font-weight:600;}
#__ce-bar header .dot{width:8px;height:8px;border-radius:99px;background:#6366f1;}
#__ce-bar .body{padding:10px 12px;display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow:auto;}
#__ce-bar button{all:unset;text-align:center;padding:8px 10px;border-radius:8px;background:#6366f1;color:#fff;
  font-weight:600;cursor:pointer;box-sizing:border-box;}
#__ce-bar button.sec{background:#374151;}
#__ce-bar button[disabled]{opacity:.45;cursor:not-allowed;}
#__ce-bar .row{display:flex;flex-direction:column;gap:4px;}
#__ce-bar label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;}
#__ce-bar input,#__ce-bar textarea{width:100%;box-sizing:border-box;background:#1f2937;border:1px solid #374151;
  color:#f9fafb;border-radius:6px;padding:6px 8px;font:12px/1.4 ui-sans-serif,system-ui;}
#__ce-bar .count{color:#9ca3af;font-size:12px;}
#__ce-bar .imgrow{display:flex;gap:8px;align-items:center;}
#__ce-bar .imgrow img{width:34px;height:34px;object-fit:cover;border-radius:4px;background:#374151;flex:none;}
#__ce-tabs{display:flex;gap:4px;padding:8px 12px 0;}
#__ce-tabs span{padding:5px 9px;border-radius:6px;background:#1f2937;color:#9ca3af;cursor:pointer;font-size:12px;}
#__ce-tabs span.on{background:#6366f1;color:#fff;}
#__ce-toast{position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);bottom:24px;background:#065f46;
  color:#ecfdf5;padding:10px 16px;border-radius:10px;font:13px ui-sans-serif,system-ui;box-shadow:0 8px 24px rgba(0,0,0,.3);}
@media print{#__ce-bar{display:none}}
"""

JS = r"""
(function(){
  if (window.__CE_ACTIVE) { console.log('[copy-edit-mode] already running'); return; }
  window.__CE_ACTIVE = true;

  var SERVER = window.__CE_SERVER || '';
  var CSS_TEXT = __CE_CSS__;
  var SKIP = {SCRIPT:1,STYLE:1,NOSCRIPT:1,TEXTAREA:1,CODE:1,PRE:1,SVG:1,IFRAME:1,CANVAS:1,SELECT:1,OPTION:1,TEMPLATE:1};
  function skipped(el){ return SKIP[(el.tagName || '').toUpperCase()] || (el.closest && el.closest('svg')); }

  var nodes = [], imgs = [], metaTitle = null, metaDesc = null, seq = 0;
  var bar, paneSeo, countEl, saveBtn, toggleEl;
  var editing = true;

  function inBar(el){ return el && el.closest && el.closest('#__ce-bar'); }

  var INTERACTIVE = 'a,button,[role="button"],[role="link"],input,select,label,summary,[onclick]';

  function blockInteraction(e){
    if (!editing) return;
    var t = e.target;
    if (inBar(t)) return;
    if (t.closest && t.closest(INTERACTIVE)){
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function blockSubmit(e){
    if (!editing) return;
    if (inBar(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function installBlockers(){
    // capture phase, so framework handlers and router links never fire
    document.addEventListener('click', blockInteraction, true);
    document.addEventListener('auxclick', blockInteraction, true);
    document.addEventListener('submit', blockSubmit, true);
  }

  function setEditing(on){
    editing = !!on;
    document.documentElement.classList.toggle('__ce-editing', editing);
    nodes.forEach(function(n){
      if (n.el.isConnected) n.el.setAttribute('contenteditable', editing ? 'true' : 'false');
    });
    if (!editing && document.activeElement && document.activeElement.hasAttribute &&
        document.activeElement.hasAttribute('data-ce-id')) {
      document.activeElement.blur();
    }
    if (toggleEl){
      toggleEl.classList.toggle('on', editing);
      toggleEl.querySelector('.lbl').textContent = editing ? 'Edit mode' : 'Preview mode';
      toggleEl.querySelector('.hint').textContent = editing ? 'clicks disabled' : 'site is live';
    }
  }

  function fileId(){
    if (window.__CE_FILE) return window.__CE_FILE;
    var p = location.pathname;
    return (p === '/' || p === '') ? 'route:/' : 'route:' + p;
  }

  function injectCss(){
    if (document.getElementById('__ce-style')) return;
    var s = document.createElement('style');
    s.id = '__ce-style';
    s.textContent = CSS_TEXT;
    document.head.appendChild(s);
  }

  function walk(el){
    var n = el.firstChild;
    while (n){
      var next = n.nextSibling;  // read it first: mark() moves n into a new span
      if (n.nodeType === 3){
        if (n.nodeValue && n.nodeValue.trim().length){
          var p = n.parentNode;
          if (p && !skipped(p) && !p.hasAttribute('data-ce-id') &&
              !(p.closest && p.closest('#__ce-bar'))) mark(n);
        }
      } else if (n.nodeType === 1 && !skipped(n) && n.id !== '__ce-bar' &&
                 !n.hasAttribute('data-ce-id')){
        walk(n);
      }
      n = next;
    }
  }

  // the text as typed, not as shown: innerText applies text-transform (an uppercase label would look edited)
  function textOf(el){
    var out = '';
    for (var n = el.firstChild; n; n = n.nextSibling){
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeName === 'BR') out += '\n';
      else if (n.nodeType === 1){
        if (/^(DIV|P)$/.test(n.nodeName) && out && out.slice(-1) !== '\n') out += '\n';
        out += textOf(n);
      }
    }
    return out;
  }

  // what the user typed: browsers turn typed spaces at the edges into no-break spaces; keep real ones only
  function typed(el, original){
    var t = textOf(el);
    // Chrome adds a <br> after a line break typed at the end; drop that one
    if (t.slice(-1) === '\n' && original.slice(-1) !== '\n') t = t.slice(0, -1);
    return original.indexOf('\u00a0') < 0 ? t.replace(/\u00a0/g, ' ') : t;
  }

  function mark(textNode){
    var span = document.createElement('span');
    span.setAttribute('data-ce-id', ++seq);
    span.setAttribute('contenteditable', editing ? 'true' : 'false');
    span.setAttribute('spellcheck', 'true');
    textNode.parentNode.replaceChild(span, textNode);
    span.appendChild(textNode);
    var original = textNode.nodeValue;
    var rec = {el: span, before: original};
    nodes.push(rec);

    span.addEventListener('input', function(){
      span.setAttribute('data-ce-dirty', typed(span, original) !== original ? '1' : '0');
      refresh();
    });
    span.addEventListener('paste', function(e){
      e.preventDefault();
      var t = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\s*\r?\n\s*/g, ' ');
      document.execCommand('insertText', false, t);
    });
    span.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); span.blur(); }
    });
  }

  function collectExtras(){
    imgs = [];
    Array.prototype.forEach.call(document.images, function(img){
      if (img.closest && img.closest('#__ce-bar')) return;
      imgs.push({el: img, before: img.getAttribute('alt') || ''});
    });
    metaTitle = {before: document.title || '', after: document.title || ''};
    var m = document.querySelector('meta[name="description"]');
    metaDesc = {before: m ? (m.getAttribute('content') || '') : '',
                after:  m ? (m.getAttribute('content') || '') : '',
                exists: !!m};
  }

  function ancestry(el){
    var out = [], n = el.parentElement, i = 0;
    while (n && i < 3){
      var t = n.tagName.toLowerCase();
      if (n.className && typeof n.className === 'string')
        t += '.' + n.className.trim().split(/\s+/).slice(0, 4).join('.');
      out.unshift(t);
      n = n.parentElement; i++;
    }
    return out.join(' > ');
  }

  function textChanges(){
    var out = [];
    nodes.forEach(function(n){
      if (!n.el.isConnected) return;
      var after = typed(n.el, n.before);
      if (after !== n.before) out.push({
        type: 'text', file: fileId(), url: location.pathname,
        before: n.before, after: after,
        selector: ancestry(n.el),
        context: n.el.parentElement ? n.el.parentElement.outerHTML.slice(0, 300) : ''
      });
    });
    return out;
  }

  function extraChanges(){
    var out = [];
    imgs.forEach(function(i){
      var after = i.input ? i.input.value : i.before;
      if (after !== i.before) out.push({
        type: 'alt', file: fileId(), url: location.pathname,
        src: i.el.getAttribute('src'), before: i.before, after: after});
    });
    if (metaTitle && metaTitle.after !== metaTitle.before)
      out.push({type: 'meta-title', file: fileId(), url: location.pathname,
                before: metaTitle.before, after: metaTitle.after});
    if (metaDesc && metaDesc.after !== metaDesc.before)
      out.push({type: 'meta-description', file: fileId(), url: location.pathname,
                before: metaDesc.before, after: metaDesc.after, exists: metaDesc.exists});
    return out;
  }

  function allChanges(){ return textChanges().concat(extraChanges()); }

  function refresh(){
    if (!countEl) return;
    var n = allChanges().length;
    countEl.textContent = n === 0 ? 'No changes yet'
      : n + (n === 1 ? ' change' : ' changes') + ' pending';
    saveBtn.disabled = n === 0;
  }

  function toast(msg, bad){
    var t = document.createElement('div');
    t.id = '__ce-toast';
    if (bad) t.style.background = '#7f1d1d';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.remove(); }, 3500);
  }

  function field(label, value, onchange, multiline){
    var row = document.createElement('div');
    row.className = 'row';
    var lab = document.createElement('label');
    lab.textContent = label;
    var inp = document.createElement(multiline ? 'textarea' : 'input');
    if (multiline) inp.rows = 3;
    inp.value = value;
    inp.addEventListener('input', function(){ onchange(inp.value); });
    row.appendChild(lab); row.appendChild(inp);
    return row;
  }

  function buildSeoPane(){
    paneSeo.innerHTML = '';
    var frag = document.createElement('div');
    frag.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    frag.appendChild(field('Page title', metaTitle.before, function(v){ metaTitle.after = v; refresh(); }));
    frag.appendChild(field('Meta description', metaDesc.before, function(v){ metaDesc.after = v; refresh(); }, true));
    imgs.forEach(function(i, idx){
      var row = document.createElement('div');
      row.className = 'row';
      var lab = document.createElement('label');
      lab.textContent = 'Alt text - image ' + (idx + 1);
      var wrap = document.createElement('div');
      wrap.className = 'imgrow';
      var thumb = document.createElement('img');
      thumb.src = i.el.getAttribute('src') || '';
      var inp = document.createElement('input');
      inp.value = i.before;
      inp.addEventListener('input', refresh);
      i.input = inp;
      wrap.appendChild(thumb); wrap.appendChild(inp);
      row.appendChild(lab); row.appendChild(wrap);
      frag.appendChild(row);
    });
    paneSeo.appendChild(frag);
  }

  function buildBar(){
    bar = document.createElement('div');
    bar.id = '__ce-bar';
    bar.innerHTML =
      '<header><span class="dot"></span>Copy edit mode</header>' +
      '<div id="__ce-toggle" class="on"><span class="sw"><i></i></span>' +
      '<span class="lbl">Edit mode</span><span class="hint">clicks disabled</span></div>' +
      '<div id="__ce-tabs"><span class="on" data-t="text">Text</span>' +
      '<span data-t="seo">Images &amp; SEO</span></div>' +
      '<div class="body" id="__ce-pane-text">' +
        '<div class="count" id="__ce-count">No changes yet</div>' +
        '<button id="__ce-save" disabled>Save changes</button>' +
        '<button class="sec" id="__ce-rescan">Re-scan page</button>' +
      '</div>' +
      '<div class="body" id="__ce-pane-seo" style="display:none"></div>';
    document.body.appendChild(bar);

    countEl = bar.querySelector('#__ce-count');
    saveBtn = bar.querySelector('#__ce-save');
    paneSeo = bar.querySelector('#__ce-pane-seo');
    toggleEl = bar.querySelector('#__ce-toggle');

    toggleEl.addEventListener('click', function(){ setEditing(!editing); });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && !inBar(e.target)) setEditing(!editing);
    });

    bar.querySelectorAll('#__ce-tabs span').forEach(function(s){
      s.addEventListener('click', function(){
        bar.querySelectorAll('#__ce-tabs span').forEach(function(x){ x.classList.remove('on'); });
        s.classList.add('on');
        var isText = s.dataset.t === 'text';
        bar.querySelector('#__ce-pane-text').style.display = isText ? 'flex' : 'none';
        paneSeo.style.display = isText ? 'none' : 'flex';
      });
    });

    bar.querySelector('#__ce-rescan').addEventListener('click', function(){
      scan(true);
      toast('Re-scanned. ' + nodes.length + ' editable spots.');
    });
    saveBtn.addEventListener('click', save);
  }

  function scan(keepEdits){
    if (!keepEdits) nodes = [];
    else nodes = nodes.filter(function(n){ return n.el.isConnected; });
    walk(document.body);
    collectExtras();
    if (paneSeo) buildSeoPane();
    refresh();
  }

  function save(){
    var changes = allChanges();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    fetch(SERVER + '/__ce_save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({file: fileId(), url: location.href,
                            savedAt: new Date().toISOString(), changes: changes})
    }).then(function(r){
      if (!r.ok) throw new Error(r.status === 403 ? 'Only pages on localhost or 127.0.0.1 can save.' : 'Save failed (' + r.status + ').');
      return r.json();
    }).then(function(r){
      saveBtn.textContent = 'Save changes';
      toast(r.count + ' change(s) saved. Tell Claude to apply them.');
    }).catch(function(err){
      saveBtn.textContent = 'Save changes';
      saveBtn.disabled = false;
      toast(err && err.message && !/fetch/i.test(err.message) ? err.message : 'Save failed - is the copy-edit server still running?', true);
    });
  }

  function boot(){
    injectCss();
    installBlockers();
    buildBar();
    scan(false);
    setEditing(true);
    console.log('[copy-edit-mode] ' + nodes.length + ' editable spots on ' + fileId());
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function(){ setTimeout(boot, 300); });
  } else {
    setTimeout(boot, 300);
  }
})();
"""


def overlay_js(server_origin=""):
    js = JS.replace("__CE_CSS__", json.dumps(CSS))
    prefix = ""
    if server_origin:
        prefix = 'window.__CE_SERVER=%s;\n' % json.dumps(server_origin)
    return prefix + js


class Handler(SimpleHTTPRequestHandler):
    root = "."
    mode = "static"
    origin = ""
    out = ""

    def _cors(self):
        # only pages on this computer may talk to the server (another website could otherwise plant edits)
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

        if path == "/__ce_overlay.js":
            self._send(overlay_js(self.origin).encode("utf-8"), "application/javascript; charset=utf-8")
            return

        if self.mode == "collector":
            self._send(b"copy-edit-mode collector running. Load /__ce_overlay.js on your app page.",
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
            self.send_error(404)
            return
        if full.endswith((".html", ".htm")):
            rel = os.path.relpath(full, self.root).replace("\\", "/")
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                html = f.read()
            inject = ('<script>window.__CE_FILE=%s;</script>\n<script>%s</script>\n'
                      % (json.dumps(rel).replace("</", "<\\/"), overlay_js()))
            # before the last </body>: an earlier one can sit in a comment or a script
            ends = list(re.finditer(r"</body\s*>", html, re.I))
            html = html[: ends[-1].start()] + inject + html[ends[-1].start():] if ends else html + inject
            self._send(html.encode("utf-8"), "text/html; charset=utf-8")
            return

        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if self._foreign_host():
            return
        if urlparse(self.path).path != "/__ce_save":
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
            payload = json.loads(self.rfile.read(length).decode("utf-8"), parse_constant=_no_constant)
            if not isinstance(payload, dict) or not isinstance(payload.get("changes", []), list):
                raise ValueError
        except Exception:
            self._send(b'{"ok":false}', "application/json", 400)
            return
        with LOCK:
            try:
                with open(self.out, "r", encoding="utf-8") as f:
                    store = json.load(f)
                if not isinstance(store, dict) or not isinstance(store.get("batches"), list):
                    raise ValueError
            except FileNotFoundError:
                store = {"batches": []}
            except Exception:
                # keep a damaged file instead of losing earlier edits
                os.replace(self.out, self.out.replace(".json", ".broken-%s.json" % datetime.now().strftime("%H%M%S")))
                store = {"batches": []}
            store["batches"].append(payload)
            write_atomic(self.out, store)
        n = len(payload.get("changes", []))
        self._send(json.dumps({"ok": True, "count": n}).encode(), "application/json")
        print("[%s] saved %d change(s) from %s"
              % (datetime.now().strftime("%H:%M:%S"), n, payload.get("file")), flush=True)

    def log_message(self, *args):
        pass


def _no_constant(name):
    raise ValueError("NaN and Infinity aren't JSON")


def write_atomic(path, data):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".copy-changes-", suffix=".json", dir=d)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


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
                    help="static: site folder. collector: project root where copy-changes.json is written.")
    ap.add_argument("--port", type=int, default=4321)
    args = ap.parse_args()

    Handler.root = os.path.realpath(args.root)
    Handler.mode = args.mode
    Handler.origin = "http://localhost:%d" % args.port
    Handler.out = os.path.join(Handler.root, "copy-changes.json")
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
        print("Copy edit mode (static) at http://localhost:%d" % args.port)
        print("Serving: %s" % Handler.root)
        for p in pages[:25]:
            print("   http://localhost:%d/%s" % (args.port, p))
    else:
        print("Copy edit mode (collector) at http://localhost:%d" % args.port)
        print("Overlay script: http://localhost:%d/__ce_overlay.js" % args.port)
    print("Saving edits to: %s" % Handler.out)
    print("Ctrl+C to stop.", flush=True)
    if server6:
        threading.Thread(target=server6.serve_forever, daemon=True).start()
    try:
        server4.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
