/*
  Tweak mode: pick anything on the page and tune its type, spacing, size and colors in a small panel.
  Edits show live; Save sends them to the tweak server, and Claude writes them into the code.

  Picking: with Auto select on, a click picks; with it off, hold Option (Alt) and click.
  A click picks the outermost thing first, then things at the same level; a double click goes one level in;
  Cmd-click picks the innermost thing under the pointer. Enter picks the first thing inside, Shift+Enter the box
  around it. Esc lets go. Cmd-Z / Shift-Cmd-Z undo and redo.
*/
(() => {
  if (window.__tweakMode) return;
  window.__tweakMode = true;

  const SERVER = typeof window.__TW_SERVER === 'string' ? window.__TW_SERVER : '';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ------------------------------------------------------------------ state
  const S = {
    auto: store.get('tweak-auto-select', true),
    open: store.get('tweak-open', true),
    sel: null,
    scope: 'all',
    edits: new Map(),   // key -> edit
    undo: [], redo: [],
    savedSnapshot: '[]',
    note: '', noteError: false,
    hover: null,
    pointer: { x: -1, y: -1 },
    mods: { alt: false, meta: false },
    fonts: [],          // [{ label, value, google? }]
  };
  let nextId = 1;

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root) => (root || shadow).querySelector(sel);
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const cs = el => getComputedStyle(el);
  const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const round = n => Math.round(n * 100) / 100;
  const fmtPx = v => { const n = parseFloat(v); return Number.isFinite(n) ? String(round(n)) : ''; };
  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));

  // colors: any CSS color to [r, g, b, a] through a canvas pixel
  const cvs = document.createElement('canvas'); cvs.width = cvs.height = 1;
  const cx = cvs.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function rgba(str) {
    if (!str) return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let out = null;
    if (str === 'transparent') out = [0, 0, 0, 0];
    else {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = '#010203'; const before = cx.fillStyle;
      cx.fillStyle = str;
      if (cx.fillStyle !== before || /^#?010203$/i.test(str)) {
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        out = [d[0], d[1], d[2], round(d[3] / 255)];
      }
    }
    colorCache.set(str, out);
    return out;
  }
  const hex2 = n => n.toString(16).padStart(2, '0').toUpperCase();
  function toHex(str) {
    const c = rgba(str); if (!c) return '';
    return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
  }
  const alphaOf = str => { const c = rgba(str); return c ? c[3] : 1; };
  const sameColor = (a, b) => { const x = rgba(a), y = rgba(b); return !!x && !!y && x.every((v, i) => Math.abs(v - y[i]) < (i === 3 ? 0.02 : 1.5)); };

  // ------------------------------------------------------------------ the page's tokens (CSS custom properties)
  let tokens = null;
  function readTokens() {
    const names = new Set();
    const walk = rules => {
      for (const r of rules) {
        if (r.constructor && r.constructor.name === 'CSSImportRule') { try { walk(r.styleSheet.cssRules); } catch {} continue; }
        if (r.cssRules && !(r.selectorText)) { try { walk(r.cssRules); } catch {} continue; }
        if (!r.style || !r.selectorText) continue;
        if (!/(^|,)\s*(:root|html|:host)\b/.test(r.selectorText)) continue;
        for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith('--')) names.add(r.style[i]);
      }
    };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch {} }
    const root = cs(document.documentElement);
    const colors = [], lengths = [];
    for (const name of names) {
      const v = root.getPropertyValue(name).trim();
      if (!v) continue;
      if (/^-?\d*\.?\d+(px|rem)$/.test(v)) lengths.push({ name, value: v, px: v.endsWith('rem') ? parseFloat(v) * px(root.fontSize) : parseFloat(v) });
      else if (!/^-?\d*\.?\d+$/.test(v) && !/\b(var|calc)\(/.test(v) && rgba(v)) colors.push({ name, value: v, hex: toHex(v), a: alphaOf(v) });
    }
    tokens = { colors, lengths };
    return tokens;
  }
  const colorToken = val => (tokens || readTokens()).colors.find(t => sameColor(t.value, val));
  // a length token only counts for the kind of value it's named for: a font-size token isn't a line height
  const tokenFamily = name => /--line-height|leading|line-?height|\blh\b/i.test(name) ? 'leading' : /tracking|letter/i.test(name) ? 'tracking'
    : /radius|rounded|corner/i.test(name) ? 'radius' : /text-|font-?size|\bfs-|type-/i.test(name) ? 'type'
    : /space|spacing|gap|gutter|pad|margin|inset|stack/i.test(name) ? 'space' : /width|container|max-w|breakpoint|screen/i.test(name) ? 'width' : null;
  const propFamily = prop => prop === 'font-size' ? 'type' : prop === 'line-height' ? 'leading' : prop === 'letter-spacing' ? 'tracking'
    : /radius/.test(prop) ? 'radius' : /^(padding|margin|gap|row-gap|column-gap)/.test(prop) ? 'space' : /^(width|height)$/.test(prop) ? 'width' : null;
  const lengthToken = (n, prop) => {
    const fam = propFamily(prop);
    return (tokens || readTokens()).lengths.find(t => Math.abs(t.px - n) < 0.01 && (tokenFamily(t.name) === fam || (fam === 'space' && tokenFamily(t.name) === null) || (fam === 'width' && tokenFamily(t.name) === 'space')));
  };
  const tokenLabel = name => name.replace(/^--/, '');

  // colors used on the page that aren't tokens
  function pageColors() {
    const counts = new Map();
    const els = document.body.querySelectorAll('*');
    const max = Math.min(els.length, 3000);
    for (let i = 0; i < max; i++) {
      const el = els[i]; if (isOurs(el)) continue;
      const st = cs(el);
      for (const v of [st.color, st.backgroundColor, px(st.borderTopWidth) ? st.borderTopColor : null]) {
        if (!v || alphaOf(v) === 0) continue;
        const key = toHex(v) + (alphaOf(v) < 1 ? ' ' + Math.round(alphaOf(v) * 100) + '%' : '');
        counts.set(key, (counts.get(key) || { v, n: 0 })); counts.get(key).n++;
      }
    }
    return [...counts.entries()].sort((a, b) => b[1].n - a[1].n).map(([key, o]) => ({ key, value: o.v }))
      .filter(c => !colorToken(c.value)).slice(0, 16);
  }

  // fonts used on the page
  function pageFonts() {
    const counts = new Map();
    const els = document.body.querySelectorAll('*');
    const max = Math.min(els.length, 3000);
    for (let i = 0; i < max; i++) {
      const el = els[i]; if (isOurs(el)) continue;
      const fam = cs(el).fontFamily; if (!fam) continue;
      counts.set(fam, (counts.get(fam) || 0) + 1);
    }
    const out = [];
    const seen = new Set();
    for (const [fam] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const label = fontLabel(fam);
      if (seen.has(label)) continue;
      seen.add(label); out.push({ label, value: fam });
    }
    for (const g of [
      { label: 'System', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
      { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
      { label: 'Monospace', value: 'ui-monospace, Menlo, monospace' },
    ]) if (!seen.has(g.label)) out.push(g);
    return out;
  }
  function fontLabel(fam) {
    let first = fam.split(',')[0].trim().replace(/^["']|["']$/g, '');
    const m = first.match(/^__(.+?)_[0-9a-f]{4,}$/i); // next/font names, like __Geist_a1b2c3
    if (m) first = m[1].replace(/_/g, ' ');
    if (/^-apple-system|^system-ui|^BlinkMacSystemFont/i.test(first)) return 'System';
    return first;
  }

  // ------------------------------------------------------------------ which CSS rule sets a value now
  // the CSS rule that sets a property on an element now: cascade layers first, then !important, specificity and order
  const ALIAS = {
    'padding-left': ['padding-inline-start', 'padding-inline', 'padding'], 'padding-right': ['padding-inline-end', 'padding-inline', 'padding'],
    'padding-top': ['padding-block-start', 'padding-block', 'padding'], 'padding-bottom': ['padding-block-end', 'padding-block', 'padding'],
    'margin-left': ['margin-inline-start', 'margin-inline', 'margin'], 'margin-right': ['margin-inline-end', 'margin-inline', 'margin'],
    'margin-top': ['margin-block-start', 'margin-block', 'margin'], 'margin-bottom': ['margin-block-end', 'margin-block', 'margin'],
    'width': ['inline-size'], 'height': ['block-size'], 'gap': ['row-gap', 'column-gap'],
    'border-radius': ['border-top-left-radius', 'border-start-start-radius'], 'border-top-left-radius': ['border-start-start-radius', 'border-radius'],
    'border-width': ['border-top-width', 'border-block-start-width', 'border-block-width', 'border'], 'border-color': ['border-top-color', 'border-block-start-color', 'border-block-color', 'border'],
    'border-top-color': ['border-block-start-color', 'border-color', 'border'], 'background-color': ['background'], 'font-family': ['font'], 'font-size': ['font'], 'line-height': ['font'], 'font-weight': ['font'],
  };
  const specOf = sel => {
    const s = sel.replace(/:(not|is|has)\(([^()]*)\)/g, (m, f, inner) => ' ' + inner).replace(/:where\([^()]*\)/g, '').replace(/::?[\w-]+(\([^)]*\))?/g, m => (m.startsWith('::') ? ' x' : ' .p'));
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const cls = (s.match(/\.[\w-]+|\[[^\]]*\]/g) || []).length;
    const tags = (s.replace(/[#.][\w-]+|\[[^\]]*\]/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
    return ids * 10000 + cls * 100 + tags;
  };
  function findSource(el, prop, skipSheet) {
    if (el.style && el.style.getPropertyValue(prop) && !(el.dataset && el.dataset.tw)) return { where: 'inline style', value: el.style.getPropertyValue(prop) };
    const props = [prop].concat(ALIAS[prop] || []);
    const layers = new Map();
    const layerRank = name => { if (!layers.has(name)) layers.set(name, layers.size); return layers.get(name); };
    let best = null, order = 0;
    const walk = (rules, href, media, layer) => {
      for (const r of rules) {
        order++;
        const kind = r.constructor && r.constructor.name;
        if (kind === 'CSSImportRule') { try { walk(r.styleSheet.cssRules, r.styleSheet.href ? new URL(r.styleSheet.href).pathname : href, media, layer); } catch {} continue; }
        if (kind === 'CSSLayerStatementRule') { for (const n of r.nameList) layerRank((layer ? layer + '.' : '') + n); continue; }
        if (kind === 'CSSLayerBlockRule') { const n = (layer ? layer + '.' : '') + (r.name || ('anon' + order)); layerRank(n); try { walk(r.cssRules, href, media, n); } catch {} continue; }
        if (r.media && r.cssRules && !r.selectorText) { if (matchMedia(r.media.mediaText).matches) { try { walk(r.cssRules, href, r.media.mediaText, layer); } catch {} } continue; }
        if (r.cssRules && !r.selectorText) { try { walk(r.cssRules, href, media, layer); } catch {} continue; }
        if (!r.selectorText || !r.style) continue;
        let p = null, v = '';
        for (const q of props) { v = r.style.getPropertyValue(q); if (v) { p = q; break; } }
        if (!v) continue;
        for (const part of r.selectorText.split(/,(?![^(]*\))/)) {
          let ok = false; try { ok = el.matches(part); } catch {}
          if (!ok) continue;
          const imp = r.style.getPropertyPriority(p) === 'important';
          const rank = layer == null ? 1e6 : layerRank(layer);
          // important flips layer order: earlier layers win
          const score = (imp ? 2e12 + (1e6 - rank) * 1e6 : rank * 1e6) + specOf(part);
          if (!best || score > best.score || (score === best.score && order > best.order)) best = { score, order, file: href, selector: r.selectorText.trim(), property: p, value: v.trim(), media: media || null, layer: layer || null };
        }
      }
    };
    for (const sheet of document.styleSheets) {
      if (skipSheet && sheet.ownerNode && String(sheet.ownerNode.id || '').startsWith(skipSheet)) continue;
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      const href = sheet.href ? new URL(sheet.href).pathname : '<style> in the page';
      walk(rules, href, null, null);
    }
    if (!best) return null;
    delete best.score; delete best.order;
    if (best.property === prop) delete best.property;
    if (!best.layer) delete best.layer;
    return best;
  }
  const sourceOf = (el, prop) => findSource(el, prop, 'tweak-mode-');

  // ------------------------------------------------------------------ elements
  const host = document.createElement('tweak-mode');
  const isOurs = el => el === host || (el && el.closest && el.closest('tweak-mode'));
  const TEXT_TAGS = /^(H[1-6]|P|A|BUTTON|LABEL|SPAN|LI|BLOCKQUOTE|FIGCAPTION|SMALL|STRONG|EM|B|I|DT|DD|TD|TH|CAPTION|LEGEND|SUMMARY|CITE|Q|CODE|TIME|INPUT|TEXTAREA|SELECT)$/;
  const UTILITY = /^(!?-?(flex|grid|block|inline|hidden|contents|relative|absolute|fixed|sticky|static|container|group|peer|isolate|truncate|[mp][trblxyse]?-|w-|h-|size-|min-|max-|text-|font-|bg-|from-|to-|via-|border|rounded|shadow|ring|outline|gap-|space-|items-|justify-|content-|self-|place-|z-|top-|left-|right-|bottom-|inset|overflow|opacity|transition|duration|delay|ease|animate|transform|translate|scale|rotate|col-|row-|order-|leading-|tracking-|whitespace|break-|object-|aspect-|cursor|pointer|select-|sr-only|not-sr-only|underline|uppercase|lowercase|capitalize|italic|antialiased|backdrop|blur|filter|fill-|stroke-|line-clamp|basis-|grow|shrink|list-|decoration|divide|columns-)|.*:)/;
  function nameOf(el) {
    const t = el.tagName;
    if (t === 'svg' || t === 'SVG') return 'Icon';
    if (t === 'IMG' || t === 'PICTURE') return 'Image';
    if (t === 'VIDEO') return 'Video';
    if (/^H[1-6]$/.test(t)) return 'Heading ' + t[1];
    if (t === 'BUTTON' || (t === 'A' && looksLikeButton(el))) return 'Button';
    if (t === 'A') return 'Link';
    if (t === 'P') return 'Paragraph';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t)) return 'Field';
    if (t === 'LABEL') return 'Label';
    if (t === 'NAV') return 'Navigation';
    if (t === 'MAIN') return 'Main';
    if (t === 'HEADER') return 'Header';
    if (t === 'FOOTER') return 'Footer';
    if (t === 'FORM') return 'Form';
    const cls = [...el.classList].find(c => !UTILITY.test(c) && c.length > 1 && !/^[a-z]{1,3}\d|^__|^css-|^sc-|^jsx-/i.test(c));
    if (cls) { const s = cls.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase(); return s[0].toUpperCase() + s.slice(1); }
    if (t === 'LI') return 'List item';
    if (t === 'UL' || t === 'OL') return 'List';
    if (t === 'SECTION') return 'Section';
    if (t === 'STRONG' || t === 'B') return 'Bold text';
    if (t === 'EM' || t === 'I') return 'Italic text';
    if (/^(SPAN|SMALL|CODE|TIME|CITE|Q)$/.test(t)) return 'Text';
    return 'Box';
  }
  function looksLikeButton(el) {
    const st = cs(el);
    return (alphaOf(st.backgroundColor) > 0 || px(st.borderTopWidth) > 0) && px(st.paddingLeft) >= 8 && /inline-block|inline-flex|flex|block|grid/.test(st.display);
  }
  const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  function hasText(el) {
    if (el.tagName === 'IMG' || el.tagName === 'svg' || el.tagName === 'VIDEO') return false;
    if (TEXT_TAGS.test(el.tagName) || ownText(el)) return true;
    if (!el.textContent.trim()) return false;
    return [...el.querySelectorAll('*')].every(k => /^inline/.test(cs(k).display) && !/^(IMG|svg|VIDEO)$/.test(k.tagName));
  }
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && cs(el).visibility !== 'hidden'; };
  // a box that holds the page rather than a part of it: full width and most of the page's height
  const isPageBox = el => {
    const r = el.getBoundingClientRect();
    const docH = Math.max(document.documentElement.scrollHeight, innerHeight);
    return r.width >= innerWidth * 0.5 && r.height >= docH * 0.6 && el.children.length > 1;
  };
  function isWrapper(el) {
    if (ownText(el)) return false;
    const kids = [...el.children].filter(visible);
    if (kids.length !== 1) return false;
    const a = el.getBoundingClientRect(), b = kids[0].getBoundingClientRect();
    return Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2;
  }
  function normalize(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.closest('svg')) { let s = el.closest('svg'); while (s.parentElement && s.parentElement.closest('svg')) s = s.parentElement.closest('svg'); return s; }
    if (el.tagName === 'PICTURE' || el.tagName === 'SOURCE') return el.closest('picture') || el;
    return el;
  }
  function childOnPath(box, el) {
    let c = el; while (c && c.parentElement !== box) c = c.parentElement;
    return c;
  }
  const isRoot = el => !el || el === document.body || el === document.documentElement;
  function outermost(hit) {
    // the first box from the top that isn't the page itself (body, wrappers around everything, long pages of sections)
    const chain = []; for (let n = hit; n && !isRoot(n); n = n.parentElement) chain.unshift(n);
    for (const n of chain) if (!isPageBox(n) && !(isWrapper(n) && n !== hit)) return n;
    return hit;
  }
  function pickFor(hit, how) {
    hit = normalize(hit);
    if (!hit || isRoot(hit) || isOurs(hit)) return null;
    if (how === 'deep') return hit;
    const sel = S.sel && S.sel.isConnected ? S.sel : null;
    if (how === 'in' && sel && sel !== hit && sel.contains(hit)) {
      let c = childOnPath(sel, hit);
      while (c && c !== hit && isWrapper(c)) c = childOnPath(c, hit);
      return c;
    }
    if (!sel) return outermost(hit);
    if (sel.contains(hit)) return sel;
    let box = sel.parentElement;
    while (box && !box.contains(hit)) box = box.parentElement;
    if (isRoot(box) || isPageBox(box)) return outermost(hit);
    if (box === hit) return box;
    let c = childOnPath(box, hit);
    while (c && c !== hit && isPageBox(c)) c = childOnPath(c, hit);
    // the picked thing sat inside a box of its own size (a link in its list item): pick the same depth here
    if (sel.parentElement && !isRoot(sel.parentElement) && isWrapper(sel.parentElement)) while (c && c !== hit && isWrapper(c)) c = childOnPath(c, hit);
    return c;
  }

  // the elements that share this one's look: the same tag and classes. An element with classes is a group even when
  // it's the only one on this page: its rule may style the same thing on other pages, like a component.
  function groupOf(el) {
    if (el.tagName === 'svg') return null;
    const tag = el.tagName.toLowerCase();
    if (el.classList.length) {
      const sel = tag + [...el.classList].map(c => '.' + esc(c)).join('');
      const all = [...document.querySelectorAll(sel)].filter(e => !isOurs(e));
      return { selector: sel, els: all.length ? all : [el] };
    }
    const p = el.parentElement;
    if (p && p.classList.length && !isRoot(p)) {
      const sel = tag + ':not([class])';
      const psel = p.tagName.toLowerCase() + [...p.classList].map(c => '.' + esc(c)).join('');
      const all = [...document.querySelectorAll(psel + ' > ' + sel)].filter(e => !isOurs(e));
      return all.length > 1 ? { selector: psel + ' > ' + sel, els: all } : null;
    }
    return null;
  }
  function pathOf(el) {
    const parts = [];
    for (let n = el; n && !isRoot(n) && parts.length < 6; n = n.parentElement) {
      if (n.id && !/^\d|:/.test(n.id)) { parts.unshift('#' + esc(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const cls = [...n.classList].slice(0, 3).map(c => '.' + esc(c)).join('');
      p += cls;
      const sib = n.parentElement ? [...n.parentElement.children].filter(k => k.tagName === n.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      parts.unshift(p);
    }
    return parts.join(' > ');
  }
  function describe(el) {
    const open = el.outerHTML.replace(/ data-tw="\d+"/, '').replace(/ style="[^"]*"/, s => el.__twProps ? '' : s).match(/^<[^>]*>/);
    return {
      tag: el.tagName.toLowerCase(),
      name: nameOf(el),
      id: el.id || null,
      classes: el.getAttribute('class') || '',
      text: (el.innerText || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      html: open ? open[0].slice(0, 300) : '',
      path: pathOf(el),
    };
  }

  // ------------------------------------------------------------------ edits
  // An edit is one element (scope "this") or one group (scope "all") on one page, with the values changed.
  const editKey = () => {
    const g = S.scope === 'all' ? groupOf(S.sel) : null;
    if (g) return { key: 'all|' + g.selector, scope: 'all', group: g };  // a class rule is the same on every page
    if (!S.sel.dataset.tw) S.sel.dataset.tw = String(nextId++);
    return { key: 'this|' + location.pathname + '|' + S.sel.dataset.tw, scope: 'this', group: null };
  };
  function editFor(create) {
    const { key, scope, group } = editKey();
    let e = S.edits.get(key);
    if (!e && create) {
      e = { key, scope, url: location.pathname, selector: group ? group.selector : '[data-tw="' + S.sel.dataset.tw + '"]',
            count: group ? group.els.length : 1, el: S.sel, element: describe(S.sel), props: new Map(), touched: new Set() };
      S.edits.set(key, e);
    }
    return e;
  }
  // The values to show and to start from. In "All", one element's own "This one" override is left out.
  function view(el) {
    const st = getComputedStyle(el);
    if (S.scope !== 'all' || !el.__twProps || !el.__twProps.length) return st;
    const saved = el.__twProps.map(p => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
    saved.forEach(([p]) => el.style.removeProperty(p));
    const o = {};
    for (let i = 0; i < st.length; i++) o[st[i]] = st.getPropertyValue(st[i]);
    saved.forEach(([p, v, pr]) => el.style.setProperty(p, v, pr));
    const kebab = k => k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    return new Proxy(o, { get: (t, k) => k === 'getPropertyValue' ? (n => t[n] || '') : (typeof k === 'string' ? (t[kebab(k)] ?? '') : undefined) });
  }
  // two ways of writing the same value: #222 and rgb(34, 34, 34), start and left, 16px and 16.00px
  function sameValue(prop, a, b) {
    if (a == null || b == null || a === '' || b === '') return false;
    if (a === b) return true;
    if (/^var\(/.test(b)) return false;
    if (prop === 'text-align') { const n = v => (v === 'start' ? 'left' : v === 'end' ? 'right' : v); return n(a) === n(b); }
    if (/color/.test(prop) && rgba(a) && rgba(b)) return sameColor(a, b);
    if (/^-?[\d.]+px$/.test(a) && /^-?[\d.]+px$/.test(b)) return Math.abs(parseFloat(a) - parseFloat(b)) < 0.01;
    if (prop === 'font-weight' || prop === 'opacity') return Math.abs(parseFloat(a) - parseFloat(b)) < 0.001;
    return false;
  }
  // One step for Undo can change several properties (a border: its width and its style).
  function setProps(list, opts = {}) {
    if (!S.sel) return;
    const e = editFor(true);
    const items = [];
    for (const [prop, value, extra] of list) {
      if (value && window.CSS && CSS.supports && !CSS.supports(prop, value)) {
        S.note = "That value doesn't work here."; S.noteError = true;
        if (!S.scrubbing) render(); else renderFoot();
        return;
      }
      const prev = e.props.has(prop) ? e.props.get(prop).after : null;
      if (value === prev || (prev == null && !value)) continue;
      const before = e.props.has(prop) ? e.props.get(prop).before : view(S.sel).getPropertyValue(prop);
      items.push({ prop, prev, next: value, before, extra: extra || null });
    }
    if (!items.length) return;
    if (S.noteError) { S.note = ''; S.noteError = false; }
    // a drag, or the color picker's stream of colors, is one step
    const token = opts.coalesce || S.scrubbing || null;
    const last = S.undo[S.undo.length - 1];
    if (token && last && last.coalesce === token && last.edit === e) {
      for (const it of items) { const o = last.items.find(x => x.prop === it.prop); if (o) { o.next = it.next; o.extra = it.extra; } else last.items.push(it); }
    } else S.undo.push({ edit: e, items, coalesce: token });
    S.redo.length = 0;
    for (const it of items) { e.touched.add(it.prop); putProp(e, it.prop, it.next, it.before, it.extra); }
    afterChange();
  }
  const setProp = (prop, value, extra, opts) => setProps([[prop, value, extra]], opts);
  function putProp(e, prop, value, before, extra) {
    if (value == null || value === '' || sameValue(prop, before, value)) e.props.delete(prop);
    else e.props.set(prop, Object.assign({ before, after: value, source: e.props.has(prop) ? e.props.get(prop).source : sourceOf(e.el, prop) }, extra || {}));
    if (!S.edits.has(e.key)) S.edits.set(e.key, e);
    applyLive();
  }
  function undo(redo) {
    const from = redo ? S.redo : S.undo, to = redo ? S.undo : S.redo;
    const step = from.pop(); if (!step) return;
    to.push(step);
    for (const it of step.items) putProp(step.edit, it.prop, redo ? it.next : it.prev, it.before, it.extra);
    afterChange();
  }

  const liveSheet = document.createElement('style');
  liveSheet.id = 'tweak-mode-live';
  function applyLive() {
    const rules = [];
    for (const e of S.edits.values()) {
      if (e.scope === 'this') {
        // one element: an inline style, which wins over any group rule. Only on its own page.
        const el = e.el;
        if (!el || !el.isConnected) continue;
        if (e.url !== location.pathname) { for (const p of (el.__twProps || [])) el.style.removeProperty(p); el.__twProps = []; continue; }
        for (const p of (el.__twProps || [])) if (!e.props.has(p)) el.style.removeProperty(p);
        el.__twProps = [...e.props.keys()];
        for (const [p, v] of e.props) el.style.setProperty(p, v.after, 'important');
      } else if (e.props.size) {
        rules.push(e.selector + ':not(#tw-x){' + [...e.props].map(([p, v]) => p + ':' + v.after + ' !important').join(';') + '}');
      }
    }
    liveSheet.textContent = rules.join('\n');
    if (!liveSheet.isConnected) (document.head || document.documentElement).append(liveSheet);
    if (savedReady) applySaved();
  }
  let savedReady = false;

  const changedNow = () => [...S.edits.values()].filter(e => e.props.size);
  function snapshot() {
    return JSON.stringify(changedNow().map(e => [e.key, [...e.props].map(([p, v]) => [p, v.after])]));
  }
  const dirty = () => snapshot() !== S.savedSnapshot;

  function payload() {
    const pages = new Map();
    for (const e of S.edits.values()) {
      if (!e.touched || !e.touched.size) continue;
      if (!pages.has(e.url)) pages.set(e.url, { url: e.url, title: e.url === location.pathname ? document.title : '', savedAt: new Date().toISOString(), changes: [] });
      const removed = [...e.touched].filter(p => !e.props.has(p));
      const fonts = [...e.props.values()].filter(v => v.googleFont).map(v => v.googleFont);
      pages.get(e.url).changes.push({
        scope: e.scope,
        appliesTo: e.scope === 'all' ? (e.count > 1 ? e.count + ' elements on this page' : 'its class (1 element on this page)') : 'this element only',
        selector: e.scope === 'all' ? e.selector : e.element.path,
        element: e.element,
        styles: [...e.props].map(([prop, v]) => {
          const o = { prop, before: v.before, after: v.after };
          if (v.token) o.token = v.token;
          if (v.source) o.source = v.source;
          return o;
        }),
        removed: removed.length ? removed : undefined,
        googleFonts: fonts.length ? fonts : undefined,
      });
    }
    return { pages: [...pages.values()] };
  }
  async function save() {
    try {
      const r = await fetch(SERVER + '/__tweak/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      if (!r.ok) throw new Error(r.status);
      S.savedSnapshot = snapshot();
      S.note = 'Saved. Tell Claude to apply it.'; S.noteError = false;
      loadSaved();
    } catch {
      S.note = "Couldn't save. Ask Claude to restart tweak mode."; S.noteError = true;
    }
    renderFoot();
  }

  // ------------------------------------------------------------------ UI
  const ICONS = {
    x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5L2.5 6.5l3 3"/><path d="M2.5 6.5h7a3.5 3.5 0 010 7H7"/></svg>',
    chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5"/></svg>',
    left: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="12" height="1.5" rx=".75"/><rect x="2" y="7.25" width="8" height="1.5" rx=".75"/><rect x="2" y="11.5" width="10" height="1.5" rx=".75"/></svg>',
    center: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="12" height="1.5" rx=".75"/><rect x="4" y="7.25" width="8" height="1.5" rx=".75"/><rect x="3" y="11.5" width="10" height="1.5" rx=".75"/></svg>',
    right: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="12" height="1.5" rx=".75"/><rect x="6" y="7.25" width="8" height="1.5" rx=".75"/><rect x="4" y="11.5" width="10" height="1.5" rx=".75"/></svg>',
    justify: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="12" height="1.5" rx=".75"/><rect x="2" y="7.25" width="12" height="1.5" rx=".75"/><rect x="2" y="11.5" width="12" height="1.5" rx=".75"/></svg>',
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/></svg>',
  };
  const icon = n => h('span', { class: 'ic', html: ICONS[n] });

  const CSS_TEXT = `
:host { all: initial; }
:host {
  --bg: #FFFFFF; --bg2: #F7F7F7; --fg: #191A1C; --fg2: rgba(0,0,0,.5); --fg3: rgba(0,0,0,.26);
  --fill1: rgba(0,0,0,.10); --fill2: rgba(0,0,0,.08); --fill3: rgba(0,0,0,.06); --border: rgba(0,0,0,.10);
  --strong: #191A1C; --on-strong: #FFFFFF; --accent: #007AFF; --danger: #FF383C;
  --menu-shadow: 0 8px 24px rgba(0,0,0,.12); --ease: cubic-bezier(.23,1,.32,1);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #171718; --bg2: #202022; --fg: #E9E9E9; --fg2: rgba(255,255,255,.45); --fg3: rgba(255,255,255,.25);
    --fill1: rgba(255,255,255,.12); --fill2: rgba(255,255,255,.09); --fill3: rgba(255,255,255,.06); --border: rgba(255,255,255,.08);
    --strong: #FFFFFF; --on-strong: #0E0E0F; --accent: #0091FF; --danger: #FF4245; --menu-shadow: 0 8px 24px rgba(0,0,0,.45);
  }
}
* { box-sizing: border-box; }
.ui, .ui * { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif; font-size: 13px; line-height: 16px; letter-spacing: -0.26px; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
.ic { display: grid; place-items: center; width: 16px; height: 16px; flex: none; }
.ic svg { width: 16px; height: 16px; }

.panel {
  position: fixed; top: 12px; right: 12px; width: 288px; max-height: calc(100vh - 24px); display: flex; flex-direction: column;
  border-radius: 12px; background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--border), var(--menu-shadow);
  overflow: hidden; pointer-events: auto; animation: in 160ms var(--ease);
}
@keyframes in { from { opacity: 0; transform: scale(.98); } }
.head { display: flex; align-items: center; gap: 4px; height: 44px; flex: none; padding: 0 6px 0 12px; border-bottom: 1px solid var(--border); }
.title { flex: 1; min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title.is-empty { color: var(--fg2); font-weight: 400; }
.ibtn { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--fg2); transition: background-color 120ms ease, color 120ms ease; }
.ibtn:hover { background: var(--fill3); color: var(--fg); }
.ibtn svg { width: 16px; height: 16px; }
.ibtn:disabled { opacity: .4; cursor: default; background: none; }
.ibtn:focus-visible, .seg > button:focus-visible, .btn:focus-visible, .auto:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 1px; }

.body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.empty { padding: 36px 24px; color: var(--fg2); text-align: center; }
.sec { display: grid; gap: 6px; padding: 12px; }
.sec + .sec { border-top: 1px solid var(--border); }
.sec-head { font-weight: 500; min-height: 20px; display: flex; align-items: center; }
.row { display: grid; grid-template-columns: 92px minmax(0, 1fr); align-items: center; column-gap: 8px; min-height: 28px; }
.k { color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; }
.k.scrub { cursor: ew-resize; }
.row.is-changed > .k, .cell.is-changed .cap { color: var(--accent); }
.f {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; min-width: 0; padding: 0 8px; border-radius: 6px;
  background: var(--fill3); color: var(--fg); text-align: left; cursor: text; transition: background-color 120ms ease;
}
.f:hover { background: var(--fill2); }
.f:focus-within, .f.is-open { box-shadow: inset 0 0 0 1px var(--accent); }
.f input { flex: 1; min-width: 0; width: 100%; border: 0; padding: 0; background: none; outline: none; color: inherit; font-variant-numeric: tabular-nums; }
.f input::placeholder { color: var(--fg2); opacity: 1; }
.f .hint { flex: 0 1 auto; min-width: 0; max-width: 60%; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; line-height: 14px; letter-spacing: -0.22px; }
.f .pre { flex: none; color: var(--fg2); }
.pick { cursor: pointer; }
.pick .v { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pick .ic { color: var(--fg2); margin-right: -2px; }
.pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.pair.border { grid-template-columns: 56px minmax(0, 1fr); }
.cells { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.cell { display: grid; gap: 2px; min-width: 0; text-align: center; }
.cell .f { padding: 0 2px; }
.cell input { text-align: center; }
.cap { color: var(--fg2); font-size: 11px !important; line-height: 14px !important; letter-spacing: -0.22px !important; }
.row.top { align-items: start; }
.row.top > .k { line-height: 28px; }
.sw { position: relative; flex: none; display: block; width: 16px; height: 16px; border-radius: 4px; overflow: hidden;
  background: repeating-conic-gradient(var(--fill1) 0 25%, transparent 0 50%) 0 0 / 8px 8px; }
.sw::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--c, transparent); box-shadow: inset 0 0 0 1px var(--fg3); }

.seg { display: flex; gap: 2px; padding: 2px; width: 100%; border-radius: 8px; background: var(--fill3); }
.seg > button { flex: 1 1 0; min-width: 0; height: 24px; display: grid; place-items: center; padding: 0 6px; border-radius: 6px; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background-color 120ms ease, color 120ms ease; }
.seg > button:hover { color: var(--fg); }
.seg > button[aria-checked="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.1); }
@media (prefers-color-scheme: dark) { .seg > button[aria-checked="true"] { background: var(--fill1); box-shadow: none; } }
.scope { padding: 12px; border-bottom: 1px solid var(--border); }

.foot { flex: none; display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 12px; border-top: 1px solid var(--border); }
.auto { display: flex; align-items: center; gap: 8px; height: 28px; color: var(--fg); }
.switch { position: relative; display: block; flex: none; width: 26px; height: 15px; border-radius: 999px; background: var(--fill1); transition: background-color 150ms ease; }
.switch::after { content: ""; position: absolute; top: 1.5px; left: 1.5px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 0 0 .5px rgba(0,0,0,.06); transition: transform 180ms var(--ease); }
.auto[aria-checked="true"] .switch { background: var(--strong); }
.auto[aria-checked="true"] .switch::after { transform: translateX(11px); }
@media (prefers-color-scheme: dark) { .auto[aria-checked="true"] .switch::after { background: #0E0E0F; } }
.spacer { flex: 1; }
.btn { height: 28px; padding: 0 12px; border-radius: 999px; font-weight: 500; background: var(--fill3); transition: background-color 120ms ease, opacity 120ms ease; }
.btn:hover { background: var(--fill2); }
.btn.primary { background: var(--strong); color: var(--on-strong); }
.btn.primary:hover { background: color-mix(in srgb, var(--strong) 85%, var(--bg)); }
.btn:disabled { background: var(--fill3); color: var(--fg); cursor: default; }
.btn:disabled { opacity: .5; }
.note { flex: none; padding: 0 12px 10px; color: var(--fg2); }
.note.is-error { color: var(--danger); }

.menu {
  position: fixed; z-index: 2; width: 240px; max-height: 360px; display: flex; flex-direction: column; overflow: hidden;
  border-radius: 12px; background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--border), var(--menu-shadow);
  pointer-events: auto; animation: in 160ms var(--ease); transform-origin: top right;
}
.find { flex: none; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-bottom: 1px solid var(--border); color: var(--fg2); }
.find input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: none; background: none; color: var(--fg); caret-color: var(--accent); }
.find input::placeholder { color: var(--fg2); opacity: 1; }
.custom { flex: none; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.custom .f { height: 28px; padding: 0 6px; }
.custom input[type=color] { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: var(--fill3); cursor: pointer; }
.custom input[type=color]::-webkit-color-swatch-wrapper { padding: 6px; }
.custom input[type=color]::-webkit-color-swatch { border: 0; border-radius: 3px; }
.list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; overscroll-behavior: contain; }
.group { padding: 8px 6px 4px; color: var(--fg2); }
.group:first-child { padding-top: 2px; }
.item { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border-radius: 8px; color: var(--fg2); text-align: left; transition: background-color 120ms ease, color 120ms ease; }
.item > .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item > .d { flex: none; color: var(--fg2); font-variant-numeric: tabular-nums; }
.item:is(:hover, .is-active, [aria-checked="true"]) { background: var(--fill3); color: var(--fg); }
.none { padding: 8px; color: var(--fg2); }

.box { position: fixed; pointer-events: none; border-radius: 1px; }
.box.hover { box-shadow: 0 0 0 1px var(--accent); }
.box.sel { box-shadow: 0 0 0 1.5px var(--accent); }
.box.twin { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
.tag { position: absolute; left: -1.5px; bottom: calc(100% + 4px); max-width: 240px; padding: 2px 6px; border-radius: 4px; background: var(--accent); color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.tag.inside { bottom: auto; top: 4px; left: 4px; }
@media (max-width: 640px) {
  .panel { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 46vh; }
  .menu { width: min(240px, calc(100vw - 16px)); max-height: 40vh; }
}
.reopen { position: fixed; right: 12px; bottom: 12px; height: 36px; padding: 0 14px; border-radius: 999px; background: var(--strong); color: var(--on-strong); font-weight: 500; pointer-events: auto; box-shadow: var(--menu-shadow); }
`;

  host.setAttribute('data-tweak-mode', '');
  // inline !important beats any page rule, even "* { ... !important }"
  host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;pointer-events:none !important;display:block !important;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS_TEXT}</style><div class="ui"></div>`;
  const ui = shadow.querySelector('.ui');
  const hoverBox = h('div', { class: 'box hover', hidden: true });
  const selBox = h('div', { class: 'box sel', hidden: true }, h('span', { class: 'tag' }));
  const twins = h('div');
  const panel = h('div', { class: 'panel' });
  const reopen = h('button', { class: 'reopen', hidden: true, onclick: () => setOpen(true) }, 'Tweak');
  ui.append(twins, hoverBox, selBox, panel, reopen);

  shadow.addEventListener('pointerdown', e => {
    if (menu && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu();
  });
  // what happens in the panel stays in the panel: keys, clicks and focus don't reach the page's own listeners
  for (const t of ['keydown', 'keyup', 'keypress', 'input', 'change', 'wheel', 'click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'focusin', 'focusout'])
    host.addEventListener(t, e => e.stopPropagation(), t === 'wheel' ? { passive: true } : false);

  function setOpen(on) {
    S.open = on; store.set('tweak-open', on);
    panel.hidden = !on; reopen.hidden = on;
    if (!on) { select(null); closeMenu(); }
  }

  // ---- fields
  function numField({ prop, value, placeholder, hint, pre, min, onCommit, className, base }) {
    const input = h('input', { type: 'text', value: value ?? '', placeholder: placeholder ?? '', spellcheck: 'false', autocomplete: 'off' });
    const f = h('label', { class: 'f' + (className ? ' ' + className : '') }, pre ? h('span', { class: 'pre' }, pre) : null, input, hint ? h('span', { class: 'hint', title: hint }, hint) : null);
    let start = input.value;
    input.addEventListener('focus', () => { start = input.value; input.select(); });
    const commit = () => { if (input.value !== start) { start = input.value; onCommit(input.value); } };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { commit(); input.blur(); }
      else if (e.key === 'Escape') { input.value = start; input.blur(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        const from = input.value === '' ? input.placeholder : input.value;
        input.value = stepValue(from, step, min, f.__base);
        onCommit(input.value); start = input.value;
      }
    });
    input.addEventListener('blur', e => {
      const next = e.relatedTarget;
      S.refocus = next && next.dataset && next.dataset.prop ? next.dataset.prop : null;
      commit();
      S.refocus = null;
    });
    input.dataset.prop = prop;
    f.__input = input;
    f.__base = base;
    return f;
  }
  function stepValue(v, step, min, base) {
    let m = String(v).trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
    if (!m) m = [null, String(base ?? 0), ''];                 // "Auto", "Mixed": start from what it is now
    if (/^r?em$/.test(m[2])) step /= 10;                       // 1rem is 16px: step by a tenth
    else if (!m[2] && Math.abs(parseFloat(m[1])) <= 5 && /\./.test(m[1])) step /= 10; // a line-height multiplier like 1.4
    let n = round(parseFloat(m[1]) + step);
    if (min != null) n = Math.max(min, n);
    return n + (m[2] && m[2] !== 'px' ? m[2] : '');
  }
  // line height: a bare number up to 5 is a multiplier (1.5), bigger ones are px
  const lineValue = v => (/^\d*\.?\d+$/.test(String(v).trim()) && parseFloat(v) <= 5 ? String(v).trim() : lenValue(v));
  // a plain number is px; units, auto, % and var() go through as typed
  function lenValue(v) {
    v = String(v).trim();
    if (!v) return '';
    if (/^-?\d*\.?\d+$/.test(v)) return v + 'px';
    return v;
  }
  function scrub(label, field, min) {
    label.classList.add('scrub');
    label.addEventListener('pointerdown', e => {
      e.preventDefault();
      const input = field.__input;
      const typed = parseFloat(input.value === '' ? input.placeholder : input.value);
      const base = Number.isFinite(typed) ? typed : (field.__base || 0);
      const x0 = e.clientX; let moved = false;
      S.scrubbing = Date.now();
      label.setPointerCapture(e.pointerId);
      const move = ev => {
        const d = Math.round((ev.clientX - x0) / 2) * (ev.shiftKey ? 10 : 1);
        if (!d && !moved) return; moved = true;
        let n = base + d; if (min != null) n = Math.max(min, n);
        input.value = String(n); input.dispatchEvent(new Event('tw-scrub'));
      };
      const up = () => {
        label.removeEventListener('pointermove', move); label.removeEventListener('pointerup', up); label.removeEventListener('pointercancel', up);
        S.scrubbing = null;
        if (moved) { render(); drawBoxes(); }
      };
      label.addEventListener('pointermove', move); label.addEventListener('pointerup', up); label.addEventListener('pointercancel', up);
    });
    field.__input.addEventListener('tw-scrub', () => field.__input.dispatchEvent(new KeyboardEvent('keydown', { key: 'tw-live' })));
  }

  // a value that is on a token gets the token's name as a hint
  const hintFor = (n, prop) => { const t = lengthToken(n, prop); return t ? tokenLabel(t.name) : null; };
  const changed = prop => { const e = S.sel && editFor(false); return !!(e && e.props.has(prop)); };

  function row(label, control, prop, opts) {
    const changedNow = (Array.isArray(prop) ? prop : [prop]).some(p => p && changed(p));
    const k = h('span', { class: 'k' }, label);
    const r = h('div', { class: 'row' + (changedNow ? ' is-changed' : '') + (opts && opts.top ? ' top' : ''), 'data-props': (Array.isArray(prop) ? prop : [prop]).join(' ') }, k, control);
    if (opts && opts.scrub) scrub(k, opts.scrub, opts.min);
    return r;
  }
  function lengthRow(label, prop, opts = {}) {
    const st = view(S.sel);
    const raw = st.getPropertyValue(prop);
    const n = px(raw);
    const showValue = opts.explicitOnly ? (changed(prop) || !!sourceOf(S.sel, prop)) : true;
    const value = opts.read ? opts.read(raw) : (raw === 'normal' ? (opts.normal ?? '') : fmtPx(raw));
    const base = raw === 'normal' && prop === 'line-height' ? Math.round(px(st.fontSize) * 1.2) : n;
    const f = numField({
      prop, value: showValue ? value : '', placeholder: showValue ? (opts.normalPlaceholder || '') : value,
      hint: showValue ? hintFor(n, prop) : null, min: opts.min, base,
      onCommit: v => setProp(prop, opts.write ? opts.write(v) : lenValue(v), tokenExtra(v, prop)),
    });
    liveScrub(f, v => opts.write ? opts.write(v) : lenValue(v), prop);
    return row(label, f, prop, { scrub: f, min: opts.min });
  }
  function tokenExtra(v, prop) { const t = lengthToken(px(v), prop); return t && /^-?\d*\.?\d+(px)?$/.test(String(v).trim()) ? { token: t.name } : null; }
  function liveScrub(f, write, prop) {
    f.__input.addEventListener('keydown', e => { if (e.key === 'tw-live') setProp(prop, write(f.__input.value), tokenExtra(f.__input.value, prop)); });
  }
  function sidesRow(label, base) {
    const st = view(S.sel);
    const sides = ['top', 'right', 'bottom', 'left'];
    const cells = sides.map(sd => {
      const prop = base + '-' + sd;
      const f = numField({ prop, value: fmtPx(st.getPropertyValue(prop)), min: base === 'padding' ? 0 : undefined, onCommit: v => setProp(prop, lenValue(v), tokenExtra(v, prop)) });
      f.title = hintFor(px(st.getPropertyValue(prop)), prop) || '';
      const cap = h('span', { class: 'cap' }, sd[0].toUpperCase() + sd.slice(1));
      liveScrub(f, lenValue, prop);
      scrub(cap, f, base === 'padding' ? 0 : undefined);
      return h('div', { class: 'cell' + (changed(prop) ? ' is-changed' : ''), 'data-props': prop }, f, cap);
    });
    return row(label, h('div', { class: 'cells' }, cells), sides.map(s => base + '-' + s), { top: true });
  }
  function colorRow(label, prop, opts = {}) {
    const val = view(S.sel).getPropertyValue(prop);
    return row(label, colorField(prop, val, opts), prop);
  }
  function colorField(prop, val, opts = {}) {
    const a = alphaOf(val);
    const t = colorToken(val);
    const text = a === 0 ? 'None' : (t ? tokenLabel(t.name) : toHex(val));
    const f = h('button', { class: 'f pick', type: 'button' },
      h('span', { class: 'sw', style: '--c:' + val }), h('span', { class: 'v' }, text),
      a > 0 && a < 1 ? h('span', { class: 'hint' }, Math.round(a * 100) + '%') : null);
    f.addEventListener('click', () => openColorMenu(f, prop, val, opts));
    return f;
  }
  function menuRow(label, prop, current, items, onPick, opts = {}) {
    const f = h('button', { class: 'f pick', type: 'button' }, h('span', { class: 'v', style: opts.style || '' }, current), icon('chev'));
    f.addEventListener('click', () => openListMenu(f, items, onPick, opts));
    return row(label, f, prop);
  }

  // ---- menus
  let menu = null;
  function closeMenu(fromRender) {
    if (!menu) return;
    menu.el.remove(); menu.anchor.classList.remove('is-open'); menu = null;
    S.picker = null;
    if (!fromRender && S.pendingRender) { S.pendingRender = false; render(); drawBoxes(); }
  }
  function placeMenu(el, anchor) {
    const pr = panel.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    ui.append(el);
    const w = el.offsetWidth, hgt = el.offsetHeight;
    let left = pr.left - w - 8;
    if (left < 8) left = Math.max(8, pr.right - w);
    let top = Math.min(ar.top - 8, innerHeight - hgt - 12);
    el.style.left = left + 'px'; el.style.top = Math.max(12, top) + 'px';
  }
  function openListMenu(anchor, items, onPick, opts = {}) {
    if (menu && menu.anchor === anchor) return closeMenu();
    closeMenu();
    const list = h('div', { class: 'list' });
    const el = h('div', { class: 'menu' });
    let find = null, active = 0, shown = [];
    if (opts.search) {
      find = h('input', { type: 'text', placeholder: opts.search, spellcheck: 'false' });
      el.append(h('label', { class: 'find' }, icon('search'), find));
    }
    el.append(list);
    const draw = () => {
      const q = find ? find.value.trim().toLowerCase() : '';
      list.textContent = '';
      shown = items.filter(i => !i.group && (!q || i.label.toLowerCase().includes(q)));
      let lastGroup = null;
      for (const it of items) {
        if (it.group) { lastGroup = it.group; continue; }
        if (!shown.includes(it)) continue;
        if (lastGroup) { list.append(h('div', { class: 'group' }, lastGroup)); lastGroup = null; }
        const b = h('button', { class: 'item', type: 'button', 'aria-checked': it.current ? 'true' : 'false', onclick: () => { onPick(it); closeMenu(); } },
          it.swatch ? h('span', { class: 'sw', style: '--c:' + it.swatch }) : null,
          h('span', { class: 't', style: it.style || '' }, it.label), it.detail ? h('span', { class: 'd' }, it.detail) : null);
        list.append(b);
      }
      if (q && opts.extra) { const x = opts.extra(find.value.trim()); if (x) { shown.push(x); list.append(h('button', { class: 'item', type: 'button', onclick: () => { onPick(x); closeMenu(); } }, h('span', { class: 't' }, x.label))); } }
      if (!list.children.length) list.append(h('div', { class: 'none' }, 'Nothing found'));
      active = 0; mark();
    };
    const buttons = () => [...list.querySelectorAll('.item')];
    const mark = () => buttons().forEach((b, i) => b.classList.toggle('is-active', !!find && i === active && !!find.value));
    if (find) {
      find.addEventListener('input', draw);
      find.addEventListener('keydown', e => {
        const bs = buttons();
        if (e.key === 'ArrowDown') { active = Math.min(bs.length - 1, active + 1); mark(); bs[active] && bs[active].scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); mark(); bs[active] && bs[active].scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
        else if (e.key === 'Enter') { bs[active] && bs[active].click(); }
        else if (e.key === 'Escape') { if (find.value) { find.value = ''; draw(); } else closeMenu(); e.preventDefault(); }
      });
    }
    draw();
    menu = { el, anchor };
    anchor.classList.add('is-open');
    placeMenu(el, anchor);
    const cur = list.querySelector('[aria-checked="true"]'); if (cur) cur.scrollIntoView({ block: 'center' });
    if (find) find.focus();
  }
  function openColorMenu(anchor, prop, val, opts) {
    if (menu && menu.anchor === anchor) return closeMenu();
    const items = [];
    const toks = (tokens || readTokens()).colors;
    if (opts.none) items.push({ label: 'None', value: 'transparent', swatch: 'transparent', current: alphaOf(val) === 0 });
    if (toks.length) { items.push({ group: 'Color tokens' }); for (const t of toks) items.push({ label: tokenLabel(t.name), value: 'var(' + t.name + ')', token: t.name, swatch: t.value, detail: t.hex + (t.a < 1 ? ' ' + Math.round(t.a * 100) + '%' : ''), current: sameColor(t.value, val) && alphaOf(val) > 0 }); }
    const others = pageColors();
    if (others.length) { items.push({ group: 'On this page' }); for (const c of others) items.push({ label: c.key, value: c.key.includes('%') ? c.value : c.key.split(' ')[0], swatch: c.value, current: sameColor(c.value, val) && !toks.some(t => sameColor(t.value, val)) }); }
    openListMenu(anchor, items, it => setProp(prop, it.value, it.token ? { token: it.token } : null), { search: items.length > 10 ? 'Search' : null });
    // a color of one's own, at the top: typed, or from the system picker
    const hexIn = h('input', { type: 'text', value: alphaOf(val) ? toHex(val) : '', placeholder: '#000000', spellcheck: 'false' });
    const pickIn = h('input', { type: 'color', value: alphaOf(val) ? toHex(val).toLowerCase() : '#000000', title: 'Pick a color' });
    const use = (v, coalesce) => { if (!rgba(v)) return; setProp(prop, v.startsWith('#') ? v.toUpperCase() : v, null, { coalesce }); };
    hexIn.addEventListener('keydown', e => { if (e.key === 'Enter') { let v = hexIn.value.trim(); if (/^[0-9a-f]{3,8}$/i.test(v)) v = '#' + v; use(v); } if (e.key === 'Escape') closeMenu(); });
    pickIn.addEventListener('input', () => { S.picker = S.picker || Date.now(); hexIn.value = pickIn.value.toUpperCase(); use(pickIn.value, S.picker); });
    pickIn.addEventListener('change', () => { S.picker = null; });
    const custom = h('div', { class: 'custom' }, h('label', { class: 'f' }, hexIn), pickIn);
    menu.el.prepend(custom);
    placeMenu(menu.el, anchor);
    if (!menu.el.querySelector('.find input')) hexIn.focus();
  }

  // ---- fonts
  const WEIGHTS = [[100, 'Thin'], [200, 'Extra light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']];
  // Google's names are case-sensitive: try it as typed, then in title case ("lora" -> "Lora")
  async function findGoogleFont(name) {
    const title = name.replace(/\b\w/g, c => c.toUpperCase());
    for (const n of title === name ? [name] : [name, title]) if (await loadGoogleFont(n)) return n;
    return null;
  }
  function loadGoogleFont(name) {
    return new Promise(resolve => {
      const fam = encodeURIComponent(name).replace(/%20/g, '+');
      const add = (href, fallback) => {
        const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.dataset.tweakFont = name;
        l.onload = () => document.fonts.load('16px "' + name + '"').then(f => resolve(f.length > 0), () => resolve(false));
        l.onerror = () => { l.remove(); fallback ? fallback() : resolve(false); };
        document.head.append(l);
      };
      add(`https://fonts.googleapis.com/css2?family=${fam}:wght@100..900&display=swap`,
        () => add(`https://fonts.googleapis.com/css2?family=${fam}:wght@400;500;600;700&display=swap`,
          () => add(`https://fonts.googleapis.com/css2?family=${fam}&display=swap`)));
    });
  }
  function fontItems(cur) {
    const fonts = S.fonts.length ? S.fonts : (S.fonts = pageFonts());
    const curLabel = fontLabel(cur);
    const basic = f => /^(System|Serif|Monospace)$/.test(f.label);
    const item = f => ({ label: f.label, value: f.value, style: 'font-family:' + f.value.replace(/"/g, "'"), current: f.label === curLabel });
    return [{ group: 'On this page' }, ...fonts.filter(f => !basic(f)).map(item), { group: 'Basic' }, ...fonts.filter(basic).map(item)];
  }

  // ---- render
  function render() {
    closeMenu(true);
    S.pendingRender = false;
    const oldBody = panel.querySelector('.body');
    const keepScroll = oldBody && S.renderedFor === S.sel ? oldBody.scrollTop : 0;
    S.renderedFor = S.sel;
    panel.textContent = '';
    const el = S.sel;
    if (!el) S.group = null;
    const head = h('div', { class: 'head' },
      h('span', { class: 'title' + (el ? '' : ' is-empty') }, el ? nameOf(el) : 'Tweak mode'),
      h('button', { class: 'ibtn', type: 'button', title: 'Undo (⌘Z)', disabled: !S.undo.length, onclick: () => undo(false), html: ICONS.undo }),
      h('button', { class: 'ibtn', type: 'button', title: 'Hide', onclick: () => setOpen(false), html: ICONS.x }));
    panel.append(head);

    if (el) {
      const g = S.group = groupOf(el);
      if (g && g.els.length > 1) {
        panel.append(h('div', { class: 'scope' }, h('div', { class: 'seg', role: 'radiogroup' },
          h('button', { type: 'button', role: 'radio', 'aria-checked': S.scope === 'this' ? 'true' : 'false', onclick: () => { S.scope = 'this'; render(); } }, 'This one'),
          h('button', { type: 'button', role: 'radio', 'aria-checked': S.scope === 'all' ? 'true' : 'false', onclick: () => { S.scope = 'all'; render(); } }, 'All ' + g.els.length + ' like it'))));
      }
    }

    const body = h('div', { class: 'body' });
    panel.append(body);
    if (!el) {
      body.append(h('div', { class: 'empty' }, S.auto
        ? 'Click anything to tweak it. Double-click goes inside, ⌘-click picks exactly what’s under the pointer.'
        : 'Hold ⌥ and click anything to tweak it. Add ⌘ to pick exactly what’s under the pointer.'));
    } else {
      const st = view(el);
      if (hasText(el)) {
        const sec = h('div', { class: 'sec' }, h('div', { class: 'sec-head' }, 'Text'));
        const fam = st.fontFamily;
        sec.append(menuRow('Font', 'font-family', fontLabel(fam), fontItems(fam), async it => {
          if (it.google) {
            const name = await findGoogleFont(it.labelName);
            if (!name) { S.note = `Couldn't find ${it.labelName} on Google Fonts.`; S.noteError = true; renderFoot(); return; }
            const value = `"${name}", ${it.fallback}`;
            if (!S.fonts.some(f => f.label === name)) S.fonts.unshift({ label: name, value });
            setProp('font-family', value, { googleFont: name });
          } else setProp('font-family', it.value);
        }, { search: 'Search or type a Google font', style: 'font-family:' + fam.replace(/"/g, "'"),
             extra: q => S.fonts.some(f => f.label.toLowerCase() === q.toLowerCase()) ? null : { label: `Google Fonts: ${q}`, google: true, labelName: q, fallback: fam.split(',').slice(1).join(',').trim() || 'sans-serif' } }));
        const w = Math.round(px(st.fontWeight) / 100) * 100;
        sec.append(menuRow('Weight', 'font-weight', (WEIGHTS.find(x => x[0] === w) || [0, st.fontWeight])[1],
          WEIGHTS.map(([n, l]) => ({ label: l, value: String(n), detail: String(n), current: n === w })), it => setProp('font-weight', it.value)));
        sec.append(lengthRow('Size', 'font-size', { min: 1 }));
        sec.append(lengthRow('Line height', 'line-height', { min: 0, normalPlaceholder: 'Auto', write: lineValue }));
        sec.append(lengthRow('Letter spacing', 'letter-spacing', { normal: '0' }));
        sec.append(colorRow('Color', 'color'));
        const ta = st.textAlign === 'start' ? (st.direction === 'rtl' ? 'right' : 'left') : st.textAlign === 'end' ? 'right' : st.textAlign;
        sec.append(row('Align', h('div', { class: 'seg', role: 'radiogroup' }, ['left', 'center', 'right', 'justify'].map(a =>
          h('button', { type: 'button', role: 'radio', title: a[0].toUpperCase() + a.slice(1), 'aria-checked': ta === a ? 'true' : 'false', onclick: () => setProp('text-align', a), html: ICONS[a] }))), 'text-align'));
        body.append(sec);
      }

      const lay = h('div', { class: 'sec' }, h('div', { class: 'sec-head' }, 'Layout'));
      lay.append(lengthRow('Width', 'width', { min: 0, explicitOnly: true }));
      lay.append(lengthRow('Height', 'height', { min: 0, explicitOnly: true }));
      if (!/^(IMG|svg|VIDEO)$/.test(el.tagName)) lay.append(sidesRow('Padding', 'padding'));
      lay.append(sidesRow('Margin', 'margin'));
      if (/flex|grid/.test(st.display)) lay.append(lengthRow('Gap', 'gap', { min: 0, read: () => fmtPx(st.rowGap === 'normal' ? st.columnGap : st.rowGap) }));
      body.append(lay);

      const sty = h('div', { class: 'sec' }, h('div', { class: 'sec-head' }, 'Style'));
      if (el.tagName !== 'svg') sty.append(colorRow('Fill', 'background-color', { none: true }));
      else sty.append(colorRow('Color', 'color'));
      const radii = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'].map(p => st.getPropertyValue(p));
      const mixed = radii.some(r => r !== radii[0]);
      const rf = numField({ prop: 'border-radius', value: mixed ? '' : fmtPx(radii[0]), placeholder: mixed ? 'Mixed' : '', hint: mixed ? null : hintFor(px(radii[0]), 'border-radius'), min: 0, onCommit: v => setProp('border-radius', lenValue(v), tokenExtra(v, 'border-radius')) });
      liveScrub(rf, lenValue, 'border-radius');
      sty.append(row('Radius', rf, 'border-radius', { scrub: rf, min: 0 }));
      const bw = px(st.borderTopWidth) && st.borderTopStyle !== 'none' ? fmtPx(st.borderTopWidth) : '0';
      // a border from nothing needs a style too: both in one step
      const setBorder = v => {
        const list = [['border-width', lenValue(v)]];
        if (px(v) > 0 && view(el).borderTopStyle === 'none') list.unshift(['border-style', 'solid']);
        setProps(list);
      };
      const bf = numField({ prop: 'border-width', value: bw, min: 0, onCommit: setBorder });
      bf.__input.addEventListener('keydown', e => { if (e.key === 'tw-live') setBorder(bf.__input.value); });
      const bc = colorField('border-color', st.borderTopColor, {});
      sty.append(row('Border', h('div', { class: 'pair border' }, bf, bc), ['border-width', 'border-color'], { scrub: bf, min: 0 }));
      // opacity in %: 50 and 0.5 both mean half
      const opv = v => { let n = parseFloat(v); if (!Number.isFinite(n)) return ''; if (/\./.test(String(v)) && n <= 1 && !/%/.test(v)) n *= 100; return String(Math.max(0, Math.min(100, n)) / 100); };
      const op = numField({ prop: 'opacity', value: String(Math.round(parseFloat(st.opacity) * 100)), hint: '%', min: 0, onCommit: v => setProp('opacity', opv(v)) });
      op.__input.addEventListener('keydown', e => { if (e.key === 'tw-live') setProp('opacity', opv(op.__input.value)); });
      sty.append(row('Opacity', op, 'opacity', { scrub: op, min: 0 }));
      body.append(sty);
    }
    if (keepScroll) body.scrollTop = keepScroll;

    const foot = h('div', { class: 'foot' });
    panel.append(foot);
    renderFoot();
  }
  function renderFoot() {
    const foot = panel.querySelector('.foot'); if (!foot) return;
    foot.textContent = '';
    const auto = h('button', { class: 'auto', type: 'button', role: 'switch', 'aria-checked': S.auto ? 'true' : 'false', onclick: () => {
      S.auto = !S.auto; store.set('tweak-auto-select', S.auto); render();
    } }, h('span', { class: 'switch' }), 'Auto select');
    const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: !dirty(), onclick: save }, 'Save');
    foot.append(auto, h('span', { class: 'spacer' }), saveBtn);
    const old = panel.querySelector('.note'); if (old) old.remove();
    if (S.note) panel.append(h('div', { class: 'note' + (S.noteError ? ' is-error' : '') }, S.note));
  }
  function afterChange() {
    if (S.note && !S.noteError) S.note = '';
    const focused = shadow.activeElement;
    const keep = S.scrubbing || !!menu || (focused && focused.tagName === 'INPUT' && focused.type === 'text' && panel.contains(focused));
    if (keep) {
      if (menu) S.pendingRender = true;
      // keep typing: refresh only the bits around the field
      refreshMarks(); renderFoot();
      const u = panel.querySelector('.head .ibtn'); if (u) u.disabled = !S.undo.length;
    } else {
      const refocus = S.refocus;
      render();
      if (refocus) { const i = panel.querySelector('input[data-prop="' + refocus + '"]'); if (i) i.focus(); }
    }
    drawBoxes();
  }
  function refreshMarks() {
    panel.querySelectorAll('[data-props]').forEach(r => r.classList.toggle('is-changed', r.dataset.props.split(' ').some(p => p && changed(p))));
  }

  function select(el) {
    if (el === S.sel) return;
    const active = shadow.activeElement; if (active && active.blur) active.blur(); // commit a number being typed
    S.sel = el;
    if (el) {
      const g = groupOf(el);
      // an element tweaked on its own before stays on its own
      S.scope = g && !(el.dataset.tw && S.edits.has('this|' + location.pathname + '|' + el.dataset.tw)) ? 'all' : 'this';
    }
    render(); drawBoxes();
  }

  // ------------------------------------------------------------------ boxes on the page
  function place(box, el) {
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    return r;
  }
  function drawBoxes() {
    const sel = S.sel && S.sel.isConnected ? S.sel : null;
    if (S.sel && !sel) { S.sel = null; render(); }
    if (sel) {
      selBox.hidden = false;
      const r = place(selBox, sel);
      const tag = selBox.firstChild;
      tag.textContent = nameOf(sel);
      tag.classList.toggle('inside', r.top < 26);
    } else selBox.hidden = true;
    const g = sel && S.scope === 'all' ? S.group : null;
    const others = g ? g.els.filter(e => e !== sel && e.isConnected && e.getClientRects().length).slice(0, 60) : [];
    while (twins.children.length > others.length) twins.lastChild.remove();
    while (twins.children.length < others.length) twins.append(h('div', { class: 'box twin' }));
    others.forEach((e, i) => place(twins.children[i], e));
    const hv = S.hover && S.hover.isConnected && S.hover !== sel ? S.hover : null;
    if (hv) { hoverBox.hidden = false; place(hoverBox, hv); } else hoverBox.hidden = true;
  }
  let raf = 0;
  const loop = () => { drawBoxes(); raf = requestAnimationFrame(loop); };

  // ------------------------------------------------------------------ the page: pointing and picking
  const picking = e => S.open && (S.auto || e.altKey);
  const overPanel = e => e.composedPath().includes(host);
  function hitAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && !isOurs(el) ? el : null;
  }
  function updateHover() {
    const { x, y } = S.pointer;
    if (!S.open || x < 0 || !(S.auto || S.mods.alt)) { S.hover = null; return; }
    const hit = hitAt(x, y);
    S.hover = hit ? pickFor(hit, S.mods.meta ? 'deep' : 'click') : null;
  }
  addEventListener('pointermove', e => {
    S.pointer = { x: e.clientX, y: e.clientY }; S.mods = { alt: e.altKey, meta: e.metaKey || e.ctrlKey };
    if (overPanel(e)) { S.hover = null; return; }
    updateHover();
  }, true);
  document.addEventListener('pointerleave', () => { S.hover = null; });
  addEventListener('keydown', e => {
    S.mods = { alt: e.altKey, meta: e.metaKey || e.ctrlKey }; updateHover();
    const typing = e.composedPath().some(n => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable);
    if (typing) return;
    const inPanel = e.composedPath().includes(host);
    const ae = document.activeElement;
    const pageHasFocus = ae && ae !== document.body && ae !== document.documentElement && !isOurs(ae);
    const keysOn = S.open && S.sel && !inPanel && (S.auto || !pageHasFocus);
    if (e.key === 'Escape' && S.open && (S.auto || !pageHasFocus)) { if (menu) closeMenu(); else select(null); }
    // Tab / Shift+Tab: the next or previous thing beside it, so anything can be reached
    if (e.key === 'Tab' && keysOn && !e.altKey && !e.metaKey && !e.ctrlKey && S.sel.parentElement) {
      e.preventDefault();
      const sibs = [...S.sel.parentElement.children].filter(c => visible(c) && !isOurs(c));
      const i = sibs.indexOf(S.sel);
      const n = sibs[(i + (e.shiftKey ? -1 : 1) + sibs.length) % sibs.length];
      if (n && n !== S.sel) select(normalize(n));
    }
    // Shift+Enter: the box it's in. Enter: the first thing in it.
    if (e.key === 'Enter' && keysOn) {
      e.preventDefault();
      if (e.shiftKey) { let p = S.sel.parentElement; while (p && !isRoot(p) && isWrapper(p) && p.parentElement && !isRoot(p.parentElement)) p = p.parentElement; if (p && !isRoot(p)) select(p); }
      else { const k = [...S.sel.children].find(c => visible(c) && !isOurs(c)); if (k) select(normalize(k)); }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && S.open && (S.undo.length || S.redo.length)) { e.preventDefault(); undo(e.shiftKey); }
  }, true);
  addEventListener('keyup', e => { S.mods = { alt: e.altKey, meta: e.metaKey || e.ctrlKey }; updateHover(); }, true);

  // While picking, the page's own clicks don't happen.
  const block = e => {
    if (overPanel(e)) return;
    if (menu && e.type === 'pointerdown') closeMenu();
    if (!picking(e)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick', 'contextmenu', 'submit', 'touchstart']) addEventListener(t, block, { capture: true, passive: false });
  addEventListener('click', e => {
    if (overPanel(e)) return;
    if (!picking(e)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const hit = hitAt(e.clientX, e.clientY);
    select(hit ? pickFor(hit, e.metaKey || e.ctrlKey ? 'deep' : 'click') : null);
  }, true);
  addEventListener('dblclick', e => {
    if (overPanel(e) || !picking(e)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) select(pickFor(hit, 'in'));
  }, true);
  addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  addEventListener('resize', () => { if (menu) closeMenu(); });
  addEventListener('scroll', () => updateHover(), { capture: true, passive: true });

  // ------------------------------------------------------------------ start
  // Tweaks saved before (this session or an earlier one) show on the page, so a reload looks the way it will.
  // Class rules show on every page; one-element tweaks only on their own page.
  const savedSheet = document.createElement('style');
  savedSheet.id = 'tweak-mode-saved';
  let saved = { pages: {} };
  const samePage = u => (u || '/').replace(/index\.html?$/, '') === location.pathname.replace(/index\.html?$/, '');
  function applySaved() {
    const rules = [];
    for (const page of Object.values(saved.pages || {})) for (const c of page.changes || []) {
      if (c.scope !== 'all' && !samePage(page.url)) continue;
      // what this session touched is shown live (and can be undone), so the saved value steps aside
      const mine = c.scope === 'all' ? S.edits.get('all|' + c.selector)
        : [...S.edits.values()].find(e => e.scope === 'this' && samePage(e.url) && e.element.path === c.selector);
      const body = (c.styles || []).filter(x => x.prop && x.after && !(mine && mine.touched.has(x.prop))).map(x => x.prop + ':' + x.after + ' !important').join(';');
      const sel = c.scope === 'all' ? c.selector + ':not(#tw-x)' : c.selector;
      try { document.querySelector(sel); } catch { continue; }
      if (body) rules.push(sel + '{' + body + '}');
    }
    savedSheet.textContent = rules.join('\n');
    if (!savedSheet.isConnected) { if (liveSheet.isConnected) liveSheet.before(savedSheet); else (document.head || document.documentElement).append(savedSheet); }
  }
  async function loadSaved() {
    try { const r = await fetch(SERVER + '/__tweak/saved'); if (r.ok) saved = await r.json(); } catch {}
    savedReady = true;
    applySaved();
  }
  function mount() {
    if (!host.isConnected) document.documentElement.append(host);
    applyLive();
    if (!savedSheet.isConnected && savedSheet.textContent) liveSheet.before(savedSheet);
  }
  mount();
  loadSaved();
  new MutationObserver(() => { if (!host.isConnected || !liveSheet.isConnected) mount(); }).observe(document.documentElement, { childList: true });
  // a page that changes its address without loading (React, Next.js): the old page's picks go
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; select(null); S.fonts = []; tokens = null; applyLive(); applySaved(); } }, 400);
  setOpen(S.open);
  render();
  raf = requestAnimationFrame(loop);
})();
