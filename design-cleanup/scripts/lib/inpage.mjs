// Copied from shared/lib by tools/sync-shared.sh. Edit it there.
// Code that runs inside the page being checked. install() puts helpers on window.__audit.
// Use: await page.evaluate(INSTALL)
function install() {
  if (window.__audit) return;
  const A = window.__audit = {};
  const cs = el => getComputedStyle(el);
  const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  A.cs = cs; A.px = px;

  // colors through a canvas pixel, so any CSS color works (oklch, color-mix...)
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  A.rgba = str => {
    if (!str) return null;
    if (cache.has(str)) return cache.get(str);
    let out = null;
    const m = String(str).match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i);
    if (str === 'transparent') out = [0, 0, 0, 0];
    else if (m) out = [+m[1], +m[2], +m[3], m[4] == null ? 1 : (m[5] ? +m[4] / 100 : +m[4])];
    else {
      // other syntaxes (oklch, color-mix...): let the browser turn it into rgb() first, then read the numbers
      const probe = document.createElement('i'); probe.style.color = str; probe.style.display = 'none';
      document.documentElement.append(probe);
      const c = getComputedStyle(probe).color; probe.remove();
      const m2 = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
      if (m2) out = [+m2[1], +m2[2], +m2[3], m2[4] == null ? 1 : +m2[4]];
      else {
        cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = str;
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data; // ImageData is not premultiplied
        out = [d[0], d[1], d[2], d[3] / 255];
      }
    }
    cache.set(str, out); return out;
  };
  A.over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1); };

  A.ownText = el => [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, ''));
  A.text = el => (el.innerText ?? el.textContent ?? '');
  A.textRect = el => {
    const nodes = A.ownText(el);
    let r = null;
    for (const n of nodes) {
      const range = document.createRange(); range.selectNodeContents(n);
      for (const b of range.getClientRects()) {
        if (b.width < 1 || b.height < 1) continue;
        r = r ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) } : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      }
    }
    if (!r) { const b = el.getBoundingClientRect(); r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; }
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  };
  A.hidden = el => {
    if (el.closest && el.closest('[inert],[aria-hidden="true"]')) return true;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.contentVisibility === 'hidden') return true;
      if (parseFloat(s.opacity) < 0.02) return true;
      // visually hidden (sr-only): clipped to nothing or 1px boxes
      if ((s.clip && s.clip !== 'auto' && /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(s.clip.replace(/\s+/g, ' '))) || s.clipPath === 'inset(50%)') return true;
      const b = n.getBoundingClientRect();
      // a closed accordion or menu: a clipping box squashed to nothing in either direction
      if ((b.width <= 1 || b.height <= 1) && /hidden|clip/.test(s.overflowX + ' ' + s.overflowY)) return true;
    }
    return false;
  };
  A.rendered = el => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const s = cs(n); if (s.display === 'none' || s.visibility === 'hidden') return false; } return true; };
  A.opacity = el => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(cs(n).opacity); return o; };

  // what's painted behind an element at a point: colors to blend, or an image/gradient
  const MEDIA = /^(IMG|VIDEO|CANVAS|IFRAME|OBJECT|EMBED|PICTURE)$/;
  A.behind = (el, x, y) => {
    const stack = document.elementsFromPoint(x, y);
    let i = stack.indexOf(el);
    if (i < 0) { i = stack.findIndex(n => n.contains(el)); if (i < 0) return null; }
    const layers = [];
    for (let k = Math.max(0, i); k < stack.length; k++) {
      const n = stack[k];
      if (n !== el && el.contains(n)) continue;
      if (n === el && MEDIA.test(n.tagName)) continue;
      if (n !== el && (MEDIA.test(n.tagName) || n.tagName.toLowerCase() === 'svg' && n.getBoundingClientRect().width > 120)) return { image: true, layers };
      const s = cs(n);
      if (s.backgroundImage && s.backgroundImage !== 'none') return { image: true, gradient: !/url\(/.test(s.backgroundImage), layers };
      const c = A.rgba(s.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) return { layers }; }
      if (s.backdropFilter && s.backdropFilter !== 'none' && c && c[3] > 0) return { image: true, layers };
    }
    // nothing opaque: the canvas
    const dark = /dark/.test(cs(document.documentElement).colorScheme) && matchMedia('(prefers-color-scheme: dark)').matches;
    layers.push(dark ? [18, 18, 18, 1] : [255, 255, 255, 1]);
    return { layers };
  };
  A.flatten = layers => { let c = layers[layers.length - 1]; for (let k = layers.length - 2; k >= 0; k--) c = A.over(layers[k], c); return c; };

  // the background under an element: scrolls it to the middle of the window and looks there
  A.background = (el, rect) => {
    const b = el.getBoundingClientRect();
    const docY = b.top + scrollY;
    scrollTo(scrollX, Math.max(0, docY - innerHeight / 2 + b.height / 2));
    const r = rect ? rect() : el.getBoundingClientRect();
    const ys = [r.y + r.height / 2];
    const xs = [r.x + Math.min(r.width / 2, 12), r.x + r.width / 2, r.x + r.width - Math.min(r.width / 2, 12)];
    let result = null;
    for (const y of ys) for (const x of xs) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const h = A.behind(el, x, y);
      if (!h) continue;
      if (h.image) return { image: true, gradient: !!h.gradient, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
      const c = A.flatten(h.layers);
      if (!result) result = c;
      else if (Math.abs(c[0] - result[0]) + Math.abs(c[1] - result[1]) + Math.abs(c[2] - result[2]) > 30) return { image: true, mixed: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    if (!result) {
      // off screen or covered: walk the ancestors
      const layers = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const s = cs(n);
        if (s.backgroundImage && s.backgroundImage !== 'none') return { image: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        const c = A.rgba(s.backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
      }
      layers.push([255, 255, 255, 1]);
      result = A.flatten(layers);
    }
    return { color: result };
  };

  // a short, stable name for where an element is: tags and classes, no positions
  A.sig = el => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      parts.unshift(n.tagName.toLowerCase() + [...n.classList].filter(c => !/^(is-|has-|js-)/.test(c)).slice(0, 2).map(c => '.' + c).join(''));
      if (n.id) { parts[0] += '#' + n.id; break; }
    }
    return parts.join(' > ');
  };
  // a selector that finds this element again
  A.path = el => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement && parts.length < 7; n = n.parentElement) {
      if (n.id && !/^\d|:/.test(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let p = n.tagName.toLowerCase() + [...n.classList].slice(0, 3).map(c => '.' + CSS.escape(c)).join('');
      const sib = n.parentElement ? [...n.parentElement.children].filter(k => k.tagName === n.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  A.label = el => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (el.closest('button,[role=button]')) return 'button';
    if (el.closest('a')) return 'link';
    if (el.closest('label,legend')) return 'label';
    if (el.closest('nav')) return 'navigation';
    if (el.closest('footer')) return 'footer';
    return 'text';
  };

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
      if (skipSheet && sheet.ownerNode && sheet.ownerNode.id === skipSheet) continue;
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
  A.source = (el, prop) => findSource(el, prop, null);

  // custom properties on :root that hold colors or lengths
  A.tokens = () => {
    const out = [];
    const seen = new Set();
    const walk = (rules, href) => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { try { walk(r.cssRules, href); } catch {} continue; }
        if (!r.style || !r.selectorText || !/(^|,)\s*(:root|html|:host)\b/.test(r.selectorText)) continue;
        for (let i = 0; i < r.style.length; i++) {
          const name = r.style[i];
          if (!name.startsWith('--') || seen.has(name + r.selectorText)) continue;
          seen.add(name + r.selectorText);
          out.push({ name, raw: r.style.getPropertyValue(name).trim(), selector: r.selectorText, file: href });
        }
      }
    };
    for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules; } catch { continue; } walk(rules, sheet.href ? new URL(sheet.href).pathname : '<style> in the page'); }
    const root = cs(document.documentElement);
    for (const t of out) t.value = root.getPropertyValue(t.name).trim();
    return out;
  };
}
export const INSTALL = `(${install.toString()})()`;
