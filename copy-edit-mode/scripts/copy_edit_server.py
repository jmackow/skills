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

# Marks on the page itself. The panel is styled inside its own shadow root (PANEL_CSS), like tweak mode.
CSS = """
html.__ce-editing [data-ce-id]{cursor:text;border-radius:2px;outline:1px solid transparent;outline-offset:2px;transition:outline-color .12s ease,background-color .12s ease;}
html.__ce-editing [data-ce-id]:hover{outline-color:rgba(0,122,255,.55);}
html.__ce-editing [data-ce-id]:focus{outline:1.5px solid #007AFF;background:rgba(0,122,255,.06);}
[data-ce-dirty="1"]{background:rgba(0,122,255,.12) !important;box-shadow:0 1.5px 0 #007AFF;-webkit-box-decoration-break:clone;box-decoration-break:clone;}
@media print{copy-edit-mode{display:none !important}}
"""

PANEL_CSS = """
:host { all: initial; }
:host {
  --bg: #FFFFFF; --fg: #191A1C; --fg2: rgba(0,0,0,.5); --fg3: rgba(0,0,0,.26);
  --fill1: rgba(0,0,0,.10); --fill2: rgba(0,0,0,.08); --fill3: rgba(0,0,0,.06); --border: rgba(0,0,0,.10);
  --strong: #191A1C; --on-strong: #FFFFFF; --accent: #007AFF; --danger: #FF383C;
  --menu-shadow: 0 8px 24px rgba(0,0,0,.12); --ease: cubic-bezier(.23,1,.32,1);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #171718; --fg: #E9E9E9; --fg2: rgba(255,255,255,.45); --fg3: rgba(255,255,255,.25);
    --fill1: rgba(255,255,255,.12); --fill2: rgba(255,255,255,.09); --fill3: rgba(255,255,255,.06); --border: rgba(255,255,255,.08);
    --strong: #FFFFFF; --on-strong: #0E0E0F; --accent: #0091FF; --danger: #FF4245; --menu-shadow: 0 8px 24px rgba(0,0,0,.45);
  }
}
* { box-sizing: border-box; }
.ui, .ui * { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif; font-size: 13px; line-height: 16px; letter-spacing: -0.26px; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
.panel {
  position: fixed; top: 12px; right: 12px; width: 288px; max-height: calc(100vh - 24px); display: flex; flex-direction: column;
  border-radius: 12px; background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--border), var(--menu-shadow);
  overflow: hidden; pointer-events: auto; animation: in 160ms var(--ease);
}
@keyframes in { from { opacity: 0; transform: scale(.98); } }
.head { display: flex; align-items: center; gap: 4px; height: 44px; flex: none; padding: 0 6px 0 12px; border-bottom: 1px solid var(--border); }
.title { flex: 1; min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.count { color: var(--fg2); white-space: nowrap; padding-right: 4px; font-variant-numeric: tabular-nums; }
.count.has { color: var(--accent); }
.ibtn { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--fg2); transition: background-color 120ms ease, color 120ms ease; }
.ibtn:hover { background: var(--fill3); color: var(--fg); }
.ibtn svg { width: 16px; height: 16px; }
.ibtn:focus-visible, .seg > button:focus-visible, .btn:focus-visible, .chg:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 1px; }
.modes { display: grid; gap: 6px; padding: 12px; border-bottom: 1px solid var(--border); }
.hint { color: var(--fg2); }
.seg { display: flex; gap: 2px; padding: 2px; width: 100%; border-radius: 8px; background: var(--fill3); }
.seg > button { flex: 1 1 0; min-width: 0; height: 24px; display: grid; place-items: center; padding: 0 6px; border-radius: 6px; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background-color 120ms ease, color 120ms ease; }
.seg > button:hover { color: var(--fg); }
.seg > button[aria-checked="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.1); }
@media (prefers-color-scheme: dark) { .seg > button[aria-checked="true"] { background: var(--fill1); box-shadow: none; } }
.body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.sec { display: grid; gap: 6px; padding: 12px; }
.sec + .sec { border-top: 1px solid var(--border); }
.sec-head { font-weight: 500; min-height: 20px; display: flex; align-items: center; }
.empty { padding: 28px 20px; color: var(--fg2); text-align: center; }
.chg { display: grid; gap: 2px; width: 100%; padding: 8px; border-radius: 8px; text-align: left; transition: background-color 120ms ease; }
.chg:hover { background: var(--fill3); }
.chg .a { color: var(--fg); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.chg .b { color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-decoration: line-through; text-decoration-color: var(--fg3); }
.lab { color: var(--fg2); }
.f {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 28px; min-width: 0; padding: 0 8px; border-radius: 6px;
  background: var(--fill3); color: var(--fg); transition: background-color 120ms ease;
}
.f:hover { background: var(--fill2); }
.f:focus-within { box-shadow: inset 0 0 0 1px var(--accent); }
.f.is-changed { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
.f input, .f textarea { flex: 1; min-width: 0; width: 100%; border: 0; padding: 6px 0; background: none; outline: none; color: inherit; resize: none; }
.f textarea { min-height: 64px; }
.f input::placeholder, .f textarea::placeholder { color: var(--fg2); opacity: 1; }
.f img { flex: none; width: 20px; height: 20px; border-radius: 4px; object-fit: cover; background: var(--fill1); }
.field { display: grid; gap: 4px; }
.foot { flex: none; display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 12px; border-top: 1px solid var(--border); }
.spacer { flex: 1; }
.btn { height: 28px; padding: 0 12px; border-radius: 999px; font-weight: 500; background: var(--fill3); transition: background-color 120ms ease, opacity 120ms ease; }
.btn:hover { background: var(--fill2); }
.btn.primary { background: var(--strong); color: var(--on-strong); }
.btn.primary:hover { background: color-mix(in srgb, var(--strong) 85%, var(--bg)); }
.btn:disabled { background: var(--fill3); color: var(--fg); cursor: default; opacity: .5; }
.note { flex: none; padding: 0 12px 10px; color: var(--fg2); }
.note.is-error { color: var(--danger); }
.reopen { position: fixed; right: 12px; bottom: 12px; height: 36px; padding: 0 14px; border-radius: 999px; background: var(--strong); color: var(--on-strong); font-weight: 500; pointer-events: auto; box-shadow: var(--menu-shadow); }
@media (max-width: 640px) {
  .panel { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 46vh; }
}
"""

JS = r"""
(function(){
  if (window.__CE_ACTIVE) { console.log('[copy-edit-mode] already running'); return; }
  window.__CE_ACTIVE = true;

  var SERVER = window.__CE_SERVER || '';
  var CSS_TEXT = __CE_CSS__;
  var PANEL_CSS = __CE_PANEL_CSS__;
  var SKIP = {SCRIPT:1,STYLE:1,NOSCRIPT:1,TEXTAREA:1,CODE:1,PRE:1,SVG:1,IFRAME:1,CANVAS:1,SELECT:1,OPTION:1,TEMPLATE:1};
  function skipped(el){ return SKIP[(el.tagName || '').toUpperCase()] || (el.closest && el.closest('svg')); }

  var nodes = [], imgs = [], metaTitle = null, metaDesc = null, seq = 0;
  var host, ui, panel, reopenBtn, countEl, saveBtn, noteEl, modeSeg, tabSeg, paneText, paneSeo, tab = 'text', noteTimer;
  var editing = true;

  // the panel lives in <copy-edit-mode> (a shadow root): events from inside it arrive with that element as target
  function inBar(el){ return el && el.closest && el.closest('copy-edit-mode'); }

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
    if (modeSeg) setSeg(modeSeg, editing ? 'edit' : 'preview');
    if (panel) panel.querySelector('.hint').textContent = editing
      ? 'Click any text and type. Links are off. Esc switches.'
      : 'Links work as usual. Esc switches back.';
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
              !(p.closest && p.closest('copy-edit-mode'))) mark(n);
        }
      } else if (n.nodeType === 1 && !skipped(n) && n.tagName !== 'COPY-EDIT-MODE' &&
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

  function h(tag, attrs){
    var el = document.createElement(tag);
    for (var k in (attrs || {})){
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.append(arguments[i]);
    return el;
  }

  function seg(items, onpick){
    var el = h('div', {class: 'seg', role: 'radiogroup'});
    items.forEach(function(it){
      el.append(h('button', {type: 'button', role: 'radio', 'data-v': it[0], 'aria-checked': 'false', text: it[1],
                             onclick: function(){ onpick(it[0]); }}));
    });
    return el;
  }
  function setSeg(el, v){
    el.querySelectorAll('button').forEach(function(b){ b.setAttribute('aria-checked', b.getAttribute('data-v') === v ? 'true' : 'false'); });
  }

  function note(msg, bad){
    noteEl.textContent = msg || '';
    noteEl.className = 'note' + (bad ? ' is-error' : '');
    noteEl.hidden = !msg;
    clearTimeout(noteTimer);
    if (msg && !bad) noteTimer = setTimeout(function(){ noteEl.hidden = true; }, 5000);
  }

  function short(t){ t = String(t).replace(/\s+/g, ' ').trim(); return t || '(empty)'; }

  function refresh(){
    if (!countEl) return;
    var all = allChanges(), n = all.length;
    countEl.textContent = n === 0 ? 'No changes' : n + (n === 1 ? ' change' : ' changes');
    countEl.className = 'count' + (n ? ' has' : '');
    saveBtn.disabled = n === 0;
    if (tab === 'text') renderText();
  }

  function renderText(){
    paneText.textContent = '';
    var edited = nodes.filter(function(n){ return n.el.isConnected && typed(n.el, n.before) !== n.before; });
    if (!edited.length){
      paneText.append(h('div', {class: 'empty', text: 'Click any text on the page and rewrite it. Edited text turns blue.'}));
      return;
    }
    var sec = h('div', {class: 'sec'}, h('div', {class: 'sec-head', text: 'Edited on this page'}));
    edited.forEach(function(n){
      sec.append(h('button', {type: 'button', class: 'chg', title: 'Show on the page', onclick: function(){
        n.el.scrollIntoView({block: 'center', behavior: 'smooth'});
        if (editing) n.el.focus({preventScroll: true});
      }}, h('span', {class: 'a', text: short(typed(n.el, n.before))}), h('span', {class: 'b', text: short(n.before)})));
    });
    paneText.append(sec);
  }

  function field(label, value, onchange, multiline, thumb){
    var inp = h(multiline ? 'textarea' : 'input', {'aria-label': label});
    if (multiline) inp.rows = 3;
    inp.value = value;
    var box = h('label', {class: 'f'}, thumb ? h('img', {src: thumb, alt: ''}) : null, inp);
    inp.addEventListener('input', function(){ box.classList.toggle('is-changed', inp.value !== value); onchange(inp.value); });
    return {row: h('div', {class: 'field'}, h('span', {class: 'lab', text: label}), box), input: inp};
  }

  function buildSeoPane(){
    paneSeo.textContent = '';
    var page = h('div', {class: 'sec'}, h('div', {class: 'sec-head', text: 'Page'}));
    page.append(field('Title', metaTitle.before, function(v){ metaTitle.after = v; refresh(); }).row);
    page.append(field('Description', metaDesc.before, function(v){ metaDesc.after = v; refresh(); }, true).row);
    paneSeo.append(page);
    if (!imgs.length) return;
    var pics = h('div', {class: 'sec'}, h('div', {class: 'sec-head', text: 'Image alt text'}));
    imgs.forEach(function(i, idx){
      var src = i.el.getAttribute('src') || '';
      var f = field((src.split('/').pop() || 'Image ' + (idx + 1)).split('?')[0], i.before, refresh, false, i.el.currentSrc || src);
      f.input.setAttribute('placeholder', 'No alt text');
      i.input = f.input;
      pics.append(f.row);
    });
    paneSeo.append(pics);
  }

  function showTab(v){
    tab = v; setSeg(tabSeg, v);
    paneText.hidden = v !== 'text'; paneSeo.hidden = v !== 'seo';
    refresh();
  }

  function setOpen(on){
    panel.hidden = !on; reopenBtn.hidden = on;
    setEditing(on);
  }

  function buildBar(){
    host = document.createElement('copy-edit-mode');
    // inline !important beats any page rule, even "* { ... !important }"
    host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;pointer-events:none !important;display:block !important;';
    var shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = '<style>' + PANEL_CSS + '</style><div class="ui"></div>';
    ui = shadow.querySelector('.ui');

    countEl = h('span', {class: 'count', text: 'No changes'});
    var close = h('button', {type: 'button', class: 'ibtn', title: 'Close (the site works as usual)', 'aria-label': 'Close',
      html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
      onclick: function(){ setOpen(false); }});
    modeSeg = seg([['edit', 'Edit'], ['preview', 'Preview']], function(v){ setEditing(v === 'edit'); });
    tabSeg = seg([['text', 'Text'], ['seo', 'Images & SEO']], showTab);
    paneText = h('div', {class: 'pane-text'});
    paneSeo = h('div', {class: 'pane-seo', hidden: ''});
    saveBtn = h('button', {type: 'button', class: 'btn primary', disabled: '', text: 'Save', onclick: save});
    var rescan = h('button', {type: 'button', class: 'btn', text: 'Re-scan', title: 'Find new text after the page changed', onclick: function(){
      scan(true); note('Re-scanned: ' + nodes.length + ' text spots.');
    }});
    noteEl = h('div', {class: 'note', hidden: ''});
    panel = h('div', {class: 'panel', role: 'dialog', 'aria-label': 'Copy edit mode'},
      h('div', {class: 'head'}, h('span', {class: 'title', text: 'Copy edit'}), countEl, close),
      h('div', {class: 'modes'}, modeSeg, h('div', {class: 'hint'})),
      h('div', {class: 'body'}, h('div', {class: 'sec', style: 'padding-bottom:0'}, tabSeg), paneText, paneSeo),
      noteEl,
      h('div', {class: 'foot'}, rescan, h('span', {class: 'spacer'}), saveBtn));
    reopenBtn = h('button', {type: 'button', class: 'reopen', hidden: '', text: 'Copy edit', onclick: function(){ setOpen(true); }});
    ui.append(panel, reopenBtn);
    document.documentElement.appendChild(host);

    // what happens in the panel stays in the panel: the page's own listeners never see it
    ['keydown', 'keyup', 'keypress', 'input', 'change', 'click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'focusin', 'focusout']
      .forEach(function(t){ host.addEventListener(t, function(e){ e.stopPropagation(); }); });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && !inBar(e.target) && !panel.hidden) setEditing(!editing);
    });
    setSeg(tabSeg, 'text');
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
    saveBtn.textContent = 'Saving';
    fetch(SERVER + '/__ce_save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({file: fileId(), url: location.href,
                            savedAt: new Date().toISOString(), changes: changes})
    }).then(function(r){
      if (!r.ok) throw new Error(r.status === 403 ? 'Only pages on localhost or 127.0.0.1 can save.' : 'Save failed (' + r.status + ').');
      return r.json();
    }).then(function(r){
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
      note('Saved ' + r.count + (r.count === 1 ? ' change' : ' changes') + '. Tell Claude to apply them.');
    }).catch(function(err){
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
      note(err && err.message && !/fetch/i.test(err.message) ? err.message : 'Save failed. Is the copy edit server still running?', true);
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
    js = JS.replace("__CE_CSS__", json.dumps(CSS)).replace("__CE_PANEL_CSS__", json.dumps(PANEL_CSS))
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
