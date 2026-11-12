#!/usr/bin/env node
// Accessibility audit: text contrast (AA and AAA), form field and icon edges, links told apart only by color,
// and small text. Checks light and dark (when the site has a dark theme) at desktop and phone width.
//
//   node a11y_audit.mjs --url http://localhost:3000 [--pages /,/about] [--max 20] [--out site-reports]
//   node a11y_audit.mjs --root ./site
//
// Writes site-reports/accessibility.html (for people) and accessibility.json (for Claude).
import fs from 'node:fs';
import { launch, target, findPages, settle, args, outDir, pathOf } from './lib/browser.mjs';
import * as C from './lib/color.mjs';
import { page as reportPage, esc, plural, where, date } from './lib/report.mjs';
import { INSTALL } from './lib/inpage.mjs';

const opts = args();
const t = await target(opts);
const out = outDir(opts, 'accessibility');
const browser = await launch();
const urls = await findPages(browser, t.start, { max: +(opts.max || 20), only: opts.pages, root: t.local });
if (!urls.length) { console.error('No pages found at ' + t.start); process.exit(1); }
console.error(`Checking ${plural(urls.length, 'page')}...`);

const SIZES = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }];

// does the site change in dark mode? Compare the colors it draws in light and in dark.
async function darkMode() {
  const look = async scheme => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const p = await ctx.newPage();
    await settle(p, urls[0]);
    const r = await p.evaluate(() => {
      const els = [document.documentElement, document.body, ...[...document.querySelectorAll('body *')].filter(e => e.childNodes.length).slice(0, 80)];
      const colors = els.map(e => { const s = getComputedStyle(e); return s.color + '|' + s.backgroundColor; }).join(';');
      // a theme switched by a class or attribute (next-themes, Tailwind "dark:" with a class)
      let byClass = false;
      const walk = rules => { for (const r of rules) { if (byClass) return; if (r.selectorText && /(^|[\s,(])(\.dark\b|\[data-(theme|mode|color-scheme)=["']?dark|\.theme-dark\b|\.dark-mode\b)/.test(r.selectorText)) byClass = true; else if (r.cssRules) { try { walk(r.cssRules); } catch {} } } };
      for (const s of document.styleSheets) { try { walk(s.cssRules); } catch {} }
      return { colors, byClass };
    });
    await ctx.close();
    return r;
  };
  const light = await look('light'), dark = await look('dark');
  return { media: light.colors !== dark.colors, byClass: light.byClass };
}
const dm = opts.light ? { media: false, byClass: false } : await darkMode();
const schemes = dm.media ? ['light', 'dark'] : ['light'];

// ------------------------------------------------------------------ collect, in the page
function collect() {
  const A = window.__audit;
  const style = document.createElement('style');
  style.textContent = '*{pointer-events:auto!important;transition:none!important;scroll-behavior:auto!important}';
  document.head.append(style);
  const items = [];
  const els = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode; if (n.textContent.trim() && n.parentElement) els.add(n.parentElement); }
  A.els = [];
  for (const el of els) {
    if (el.closest('script,style,noscript,template,svg,math,title')) continue;
    if (A.hidden(el)) continue;
    const r = A.textRect(el);
    if (r.width < 2 || r.height < 2) continue;
    if (r.x >= document.documentElement.clientWidth || r.x + r.width <= 0) continue; // off to the side: a closed drawer
    const s = A.cs(el);
    let fg = A.rgba(s.webkitTextFillColor && !/currentcolor/i.test(s.webkitTextFillColor) ? s.webkitTextFillColor : s.color);
    if (!fg || fg[3] === 0) continue;
    const op = A.opacity(el);
    const base = fg;
    fg = [fg[0], fg[1], fg[2], fg[3] * op];
    const bg = A.background(el, () => A.textRect(el));
    const text = A.ownText(el).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const idx = A.els.push(el) - 1;
    // the element that fades it, if one does
    let fader = el; while (fader && fader.nodeType === 1 && parseFloat(A.cs(fader).opacity) >= 0.999) fader = fader.parentElement;
    const opIdx = op < 0.999 && fader && fader.nodeType === 1 ? A.els.push(fader) - 1 : null;
    items.push({
      idx, kind: 'text', text: text.slice(0, 80), length: text.length, tag: el.tagName.toLowerCase(), role: A.label(el),
      size: A.px(s.fontSize), weight: +s.fontWeight || 400, fg, base, op, opIdx, bg,
      sig: A.sig(el), path: A.path(el),
      interactive: !!el.closest('a,button,[role=button],label,summary,select,input,textarea'),
    });
  }
  // placeholders
  for (const el of document.querySelectorAll('input[placeholder],textarea[placeholder]')) {
    if (A.hidden(el) || el.value) continue;
    const fg = A.rgba(getComputedStyle(el, '::placeholder').color);
    if (!fg || !el.placeholder.trim()) continue;
    const bg = A.background(el);
    const s = A.cs(el);
    const idx = A.els.push(el) - 1;
    items.push({ idx, kind: 'placeholder', text: el.placeholder.slice(0, 80), length: el.placeholder.length, tag: el.tagName.toLowerCase(), role: 'placeholder',
      size: A.px(s.fontSize), weight: +s.fontWeight || 400, fg, bg, sig: A.sig(el), path: A.path(el), source: null, interactive: true });
  }
  // form field edges (non-text contrast, 3:1)
  const fields = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=range]):not([type=color]),textarea,select')) {
    if (A.hidden(el)) continue;
    const s = A.cs(el);
    // what's around the field: look just outside its edge
    const b = el.getBoundingClientRect();
    scrollTo(scrollX, Math.max(0, b.top + scrollY - innerHeight / 2));
    const r = el.getBoundingClientRect();
    let around = null;
    for (const [x, y] of [[r.left - 3, r.top + r.height / 2], [r.right + 3, r.top + r.height / 2], [r.left + r.width / 2, r.top - 3], [r.left + r.width / 2, r.bottom + 3]]) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || top === el) continue;
      const res = A.background(top);
      if (res.color) { around = res.color; break; }
    }
    if (!around) { const p = el.parentElement && A.background(el.parentElement); around = p && p.color ? p.color : [255, 255, 255, 1]; }
    const fill = A.rgba(s.backgroundColor) || [0, 0, 0, 0];
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map(sd => ({ w: A.px(s['border' + sd + 'Width']), c: A.rgba(s['border' + sd + 'Color']), st: s['border' + sd + 'Style'] }))
      .filter(x => x.w >= 1 && x.st !== 'none' && x.c && x.c[3] > 0);
    const idx = A.els.push(el) - 1;
    fields.push({ idx, kind: 'field', text: el.getAttribute('aria-label') || el.name || el.placeholder || el.type || el.tagName.toLowerCase(), tag: el.tagName.toLowerCase(),
      around, fill, borders: sides.map(x => x.c), sig: A.sig(el), path: A.path(el), source: A.source(el, sides.length ? 'border-top-color' : 'background-color') });
  }
  // icon-only links and buttons (3:1)
  const icons = [];
  for (const el of document.querySelectorAll('a,button,[role=button]')) {
    if (A.hidden(el) || A.text(el).trim()) continue;
    const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg'); if (!svg) continue;
    let col = null;
    for (const shape of svg.querySelectorAll('path,circle,rect,polygon,line,polyline,ellipse')) {
      const ss = getComputedStyle(shape);
      const f = ss.fill && ss.fill !== 'none' ? A.rgba(ss.fill) : null;
      const k = ss.stroke && ss.stroke !== 'none' ? A.rgba(ss.stroke) : null;
      col = (f && f[3] > 0 && f) || (k && k[3] > 0 && k);
      if (col) break;
    }
    if (!col) continue;
    const bg = A.background(el);
    const idx = A.els.push(el) - 1;
    const href = el.getAttribute('href') || el.getAttribute('xlink:href');
    let where = 'icon button'; try { if (href) { const u = new URL(href, location.href); where = u.hostname + u.pathname; } } catch {}
    icons.push({ idx, kind: 'icon', text: el.getAttribute('aria-label') || el.getAttribute('title') || where, tag: el.tagName.toLowerCase(),
      fg: [col[0], col[1], col[2], col[3] * A.opacity(svg)], bg, sig: A.sig(el), path: A.path(el), source: A.source(svg, 'color') || A.source(el, 'color') });
  }
  // links inside running text that only differ by color
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (A.hidden(a)) continue;
    const s = A.cs(a);
    if (!/^inline/.test(s.display) || s.display === 'inline-block' || s.display === 'inline-flex') continue;
    // the block of text the link sits in: its nearest ancestor that isn't inline
    let block = a.parentElement;
    while (block && /^inline/.test(A.cs(block).display)) block = block.parentElement;
    if (!block || /^(H[1-6]|BUTTON|NAV|LABEL)$/.test(block.tagName) || block.closest('nav')) continue;
    const ps = A.cs(block);
    const linkText = A.text(a).trim(), blockText = A.text(block).trim();
    if (!linkText || blockText.length < linkText.length + 15) continue;
    const underlined = [a, ...a.querySelectorAll('*')].some(x => { const xs = A.cs(x); return /underline/.test(xs.textDecorationLine) || A.px(xs.borderBottomWidth) > 0; }) || (s.boxShadow && s.boxShadow !== 'none') || (s.backgroundImage && s.backgroundImage !== 'none');
    // bold counts as a cue: the weight of whatever holds the link's words
    const weight = Math.max(...[a, ...a.querySelectorAll('*')].filter(x => A.ownText(x).length).map(x => +A.cs(x).fontWeight || 400), +s.fontWeight || 400);
    const bolder = weight - (+ps.fontWeight || 400) >= 300;
    if (underlined || bolder) continue;
    const idx = A.els.push(a) - 1;
    links.push({ idx, kind: 'link', text: linkText.slice(0, 80), tag: 'a', fg: A.rgba(s.color), around: A.rgba(ps.color), sig: A.sig(a), path: A.path(a), source: A.source(a, 'text-decoration-line') || A.source(a, 'color') });
  }
  style.remove();
  scrollTo(0, 0);
  return { items, fields, icons, links, tokens: A.tokens().filter(t => t.value && !/^-?\d/.test(t.value)) };
}

// Text faded in by a scroll animation is measured where it shows: scroll to each one, wait, read again.
function remeasure(idxs) {
  const A = window.__audit;
  const read = i => { const el = A.els[i]; const s = A.cs(el); const c = A.rgba(s.webkitTextFillColor && !/currentcolor/i.test(s.webkitTextFillColor) ? s.webkitTextFillColor : s.color); const op = A.opacity(el); return c ? { fg: [c[0], c[1], c[2], c[3] * op], base: c, op } : null; };
  return new Promise(resolve => {
    const out = [];
    let k = 0;
    // one at a time: scroll it into the middle, give its animation time, read it while it's on screen
    const step = () => {
      if (k >= idxs.length) return resolve(out);
      const i = idxs[k++]; const el = A.els[i]; const b = el.getBoundingClientRect();
      scrollTo(scrollX, Math.max(0, b.top + scrollY - innerHeight / 2));
      setTimeout(() => { out.push(read(i)); step(); }, 450);
    };
    step();
  });
}
function sources(list) {
  const A = window.__audit;
  return list.map(([i, opIdx]) => ({ color: A.source(A.els[i], 'color'), opacity: opIdx != null ? A.source(A.els[opIdx], 'opacity') : null }));
}

// the text and what's around it, as people see it
async function viewShot(page, idx) {
  const r = await page.evaluate(i => {
    const el = window.__audit.els[i];
    const b = el.getBoundingClientRect();
    scrollTo(scrollX, Math.max(0, b.top + scrollY - innerHeight / 2 + b.height / 2));
    const t = el.getBoundingClientRect();
    return { x: t.x, y: t.y, w: t.width, h: t.height, vw: innerWidth, vh: innerHeight };
  }, idx);
  const pad = 24;
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  const clip = { x, y, width: Math.min(r.vw - x, r.w + pad * 2), height: Math.min(r.vh - y, r.h + pad * 2) };
  if (clip.width < 4 || clip.height < 4) return null;
  const png = await page.screenshot({ clip, animations: 'disabled' }).catch(() => null);
  return png ? png.toString('base64') : null;
}

// pixels under text that sits on a picture or gradient: hide all text, take a picture of the spot, read it
async function sample(page, idx, fg) {
  const rect = await page.evaluate(i => {
    const el = window.__audit.els[i];
    const b = el.getBoundingClientRect();
    scrollTo(scrollX, Math.max(0, b.top + scrollY - innerHeight / 2 + b.height / 2));
    const r = window.__audit.textRect(el);
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth - Math.max(0, r.x)), height: Math.min(r.height, innerHeight - Math.max(0, r.y)) };
  }, idx);
  if (rect.width < 2 || rect.height < 2) return null;
  const png = await page.screenshot({ clip: rect, animations: 'disabled' }).catch(() => null);
  if (!png) return null;
  const lum = await page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const px = [];
    const step = Math.max(1, Math.floor(d.length / 4 / 4000));
    for (let i = 0; i < d.length; i += 4 * step) px.push([d[i], d[i + 1], d[i + 2]]);
    return px;
  }, png.toString('base64'));
  if (!lum.length) return null;
  // the lowest contrast over most of the spot (ignore the worst 5% of pixels: edges, noise)
  const ratios = lum.map(p => ({ p, r: C.contrast(C.over(fg, [...p, 1]), [...p, 1]) })).sort((a, b) => a.r - b.r);
  const worst = ratios[Math.floor(ratios.length * 0.05)];
  const mid = ratios[Math.floor(ratios.length * 0.5)];
  const lums = lum.map(p => C.luminance(p)).sort((a, b) => a - b);
  const uniform = lums[Math.floor(lums.length * 0.95)] - lums[Math.floor(lums.length * 0.05)] < 0.02;
  return { ratio: worst.r, color: [...worst.p, 1], typical: [...mid.p, 1], uniform, shot: png.toString('base64') };
}

// ------------------------------------------------------------------ run
const checks = new Map();   // one per element, across pages, sizes and schemes: the worst result wins
const smalls = new Map();
let tokens = [];
const add = (key, rec) => {
  const old = checks.get(key);
  if (!old || rec.ratio < old.ratio) { if (old) rec.ratios = old.ratios; checks.set(key, rec); }
  const r = checks.get(key);
  // every place it was checked, with its ratio there, so the report can list only where it fails
  r.ratios = r.ratios || new Map();
  if (!r.ratios.has(rec.place) || rec.ratio < r.ratios.get(rec.place)) r.ratios.set(rec.place, rec.ratio);
};

for (const scheme of schemes) for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const url of urls) {
    await settle(page, url);
    await page.evaluate(INSTALL);
    const data = await page.evaluate(collect);
    if (!tokens.length) tokens = data.tokens;
    const placeOf = () => `${pathOf(url)} · ${size.name}${schemes.length > 1 ? ' · ' + scheme : ''}`;
    const large = it => it.size >= 24 || (it.size >= 18.66 && it.weight >= 700);
    const aaaNeed = it => (large(it) ? 4.5 : 7);
    // solid backgrounds
    const solid = data.items.filter(i => !i.bg.image).map(it => ({ it, bg: it.bg.color, ratio: C.contrast(C.over(it.fg, it.bg.color), it.bg.color) }));
    const failing = solid.filter(x => x.ratio < aaaNeed(x.it));
    if (failing.length) {
      // faded ones may be mid scroll-in animation: measure them again on screen (at most 40 per page)
      const faded = failing.filter(x => x.it.op < 0.999).slice(0, 40);
      const again = faded.length ? await page.evaluate(remeasure, faded.map(x => x.it.idx)).catch(() => []) : [];
      faded.forEach((x, i) => {
        const g = again[i]; if (!g) return;
        const r = C.contrast(C.over(g.fg, x.bg), x.bg);
        if (r > x.ratio) { x.ratio = r; x.it.fg = g.fg; x.it.base = g.base; x.it.op = g.op; }
      });
      const src = await page.evaluate(sources, failing.map(x => [x.it.idx, x.it.opIdx])).catch(() => []);
      failing.forEach((x, i) => { x.source = src[i] ? src[i].color : null; x.opSource = src[i] ? src[i].opacity : null; });
    }
    // on pictures and gradients: a picture as people see it, then the pixels under the hidden text
    const imgItems = data.items.filter(i => i.bg.image).slice(0, 60);
    const seenShots = {};
    for (const it of imgItems) seenShots[it.idx] = await viewShot(page, it.idx);
    const imgSrc = imgItems.length ? await page.evaluate(sources, imgItems.map(it => [it.idx, it.opIdx])).catch(() => []) : [];
    if (imgItems.length) await page.addStyleTag({ content: '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;text-decoration-color:transparent!important;transition:none!important}::placeholder{color:transparent!important}' });
    const measured = [...solid];
    for (const [k, it] of imgItems.entries()) {
      const sm = await sample(page, it.idx, it.fg);
      if (!sm) continue;
      // nearly one color under it (a see-through panel): treat it as a plain background
      measured.push({ it, bg: sm.typical, ratio: sm.uniform ? C.contrast(C.over(it.fg, sm.typical), sm.typical) : sm.ratio, image: !sm.uniform, mixed: !!it.bg.mixed, shot: sm.uniform ? null : (seenShots[it.idx] || sm.shot),
        source: imgSrc[k] ? imgSrc[k].color : null, opSource: imgSrc[k] ? imgSrc[k].opacity : null });
    }
    for (const x of measured) {
      const it = x.it, bg = x.bg, ratio = x.ratio;
      const rec = { kind: it.kind, text: it.text, role: it.role, weight: it.weight, large: large(it), interactive: it.interactive,
        fg: C.hex(C.over(it.fg, bg)), fgRaw: it.fg, base: it.base, opacity: it.op, opSource: x.opSource || null, bg: C.hex(bg), bgRaw: bg, image: !!x.image, mixed: !!x.mixed, ratio, shot: x.shot || null,
        sig: it.sig, path: it.path, source: x.source || null, page: pathOf(url), scheme, sizePx: it.size, place: placeOf() };
      add(`${it.kind}|${scheme}|${it.sig}|${it.text}`, rec);
      // small text, measured at each size
      if (it.kind === 'text' && (it.size < 12 || (it.size < 14 && it.length > 80))) {
        const k = `${it.sig}|${it.text}`;
        const old = smalls.get(k);
        if (!old || it.size < old.size) smalls.set(k, { text: it.text, size: it.size, tiny: it.size < 12, page: pathOf(url), width: size.name, sig: it.sig, path: it.path, source: null, places: old ? old.places : new Set() });
        smalls.get(k).places.add(placeOf());
      }
    }
    // field edges
    for (const f of data.fields) {
      const fill = C.over(f.fill, f.around);
      const edge = Math.max(C.contrast(fill, f.around), ...f.borders.map(b => C.contrast(C.over(b, f.around), f.around)), 1);
      add(`field|${scheme}|${f.sig}|${f.text}`, { kind: 'field', text: f.text, ratio: edge, large: false, fg: f.borders[0] ? C.hex(C.over(f.borders[0], f.around)) : C.hex(fill),
        bg: C.hex(f.around), bgRaw: f.around, fgRaw: f.borders[0] || fill, hasBorder: f.borders.length > 0, sig: f.sig, path: f.path, source: f.source, page: pathOf(url), scheme, place: placeOf(), interactive: true });
    }
    for (const ic of data.icons) {
      if (!ic.bg.color) continue;
      const fg = C.over(ic.fg, ic.bg.color);
      add(`icon|${scheme}|${ic.sig}|${ic.text}`, { kind: 'icon', text: ic.text, ratio: C.contrast(fg, ic.bg.color), large: false, fg: C.hex(fg), bg: C.hex(ic.bg.color), fgRaw: ic.fg, bgRaw: ic.bg.color,
        sig: ic.sig, path: ic.path, source: ic.source, page: pathOf(url), scheme, place: placeOf(), interactive: true });
    }
    for (const l of data.links) {
      add(`link|${scheme}|${l.sig}|${l.text}`, { kind: 'link', text: l.text, ratio: C.contrast(l.fg, l.around), large: false, fg: C.hex(l.fg), bg: C.hex(l.around), fgRaw: l.fg, bgRaw: l.around,
        sig: l.sig, path: l.path, source: l.source, page: pathOf(url), scheme, place: placeOf(), interactive: true });
    }
    process.stderr.write('.');
  }
  await ctx.close();
}
process.stderr.write('\n');
await browser.close();
t.close();

// ------------------------------------------------------------------ judge
const NEED = {
  text: r => ({ aa: r.large ? 3 : 4.5, aaa: r.large ? 4.5 : 7 }),
  placeholder: r => ({ aa: r.large ? 3 : 4.5, aaa: r.large ? 4.5 : 7 }),
  field: () => ({ aa: 3, aaa: 3 }),
  icon: () => ({ aa: 3, aaa: 3 }),
  link: () => ({ aa: 3, aaa: 3 }),
};
const all = [...checks.values()].map(r => {
  const need = NEED[r.kind](r);
  // link check: the link color against the text around it; it only fails without an underline
  const aa = r.ratio >= need.aa - 0.005, aaa = r.ratio >= need.aaa - 0.005;
  const bar = aa ? need.aaa : need.aa;
  const places = [...r.ratios].filter(([, v]) => v < bar - 0.005).map(([p]) => p);
  return { ...r, need, aa, aaa, places };
});
const pct = (n, d) => (d ? Math.floor((n / d) * 1000) / 10 : 100);
const score = {
  aa: { pass: all.filter(r => r.aa).length, total: all.length },
  aaa: { pass: all.filter(r => r.aa && r.aaa).length, total: all.length },
};
score.aa.pct = pct(score.aa.pass, score.aa.total);
score.aaa.pct = pct(score.aaa.pass, score.aaa.total);

// palette: color tokens and the colors used, for fixes that stay on brand
const palette = [];
for (const tk of tokens) { const c = C.parse(tk.value) || null; if (c && c[3] === 1) palette.push({ name: tk.name, hex: C.hex(c), c }); }
function paletteFix(fg, bg, target) {
  let best = null;
  for (const p of palette) {
    const r = C.contrast(p.c, bg);
    if (r < target) continue;
    const d = C.distance(p.c, fg);
    if (!best || d < best.d) best = { ...p, ratio: r, d };
  }
  return best && best.d < 40 ? { name: best.name, hex: best.hex, ratio: C.ratio(best.ratio) } : null;
}

// group the failures that share a look: same kind, colors and size class
const groups = new Map();
for (const r of all) {
  if (r.aa && r.aaa) continue;
  const key = r.image ? `${r.kind}|img|${r.sig}|${r.text}` : `${r.kind}|${r.fg}|${r.bg}|${r.large}|${r.aa}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const WORDS = { text: 'Text', placeholder: 'Placeholder text', field: 'Form field edges', icon: 'Icon links and buttons', link: 'Links in text' };
function roleWord(rs) {
  const k = rs[0].kind;
  if (k !== 'text') return WORDS[k];
  const roles = new Set(rs.map(r => r.role));
  if (roles.size === 1) return { heading: 'Headings', button: 'Button text', link: 'Links', label: 'Labels', navigation: 'Navigation', footer: 'Footer text', text: 'Text' }[[...roles][0]];
  return 'Text';
}
function tone(c) {
  const l = C.oklab(c)[0];
  const [, a, b] = C.oklab(c); const chroma = Math.hypot(a, b);
  const shade = l > 0.97 ? 'white' : l > 0.85 ? 'light grey' : l > 0.6 ? 'grey' : l > 0.32 ? 'dark grey' : l > 0.17 ? 'near-black' : 'black';
  if (chroma < 0.03) return shade;
  const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  const name = hue < 20 || hue >= 345 ? 'pink' : hue < 70 ? 'orange' : hue < 110 ? 'yellow' : hue < 170 ? 'green' : hue < 285 ? 'blue' : 'purple';
  return (l > 0.75 ? 'light ' : l < 0.4 ? 'dark ' : '') + name;
}

const issues = [];
for (const rs of groups.values()) {
  rs.sort((a, b) => a.ratio - b.ratio);
  const r = rs[0];
  const failsAA = !r.aa;
  let priority;
  if (!failsAA) priority = 'low';
  else if (r.kind === 'link') priority = 'high';
  else if (r.ratio < 3 || r.interactive || r.kind === 'field') priority = 'high';
  else priority = 'medium';
  const fgC = C.parse(r.fg), bgC = r.bgRaw;
  const target = failsAA ? r.need.aa : r.need.aaa;
  const fix = {};
  let needsInput = false;
  if (r.kind === 'link') {
    fix.text = 'Underline links inside text.';
  } else if (r.image && r.mixed) {
    fix.text = 'Part of the text sits on a different background, usually because it runs out of its box. Let it wrap, or give it room.';
  } else if (r.image) {
    fix.text = 'The text sits on a picture. Darken the picture under it, add a shade behind the text, or move it.';
    needsInput = true;
  } else if (r.kind === 'field' && !r.hasBorder) {
    const b = C.nearestPassing(C.parse(r.fg), bgC, 3);
    if (b) { fix.color = C.hex(b); fix.ratio = C.ratio(C.contrast(b, bgC)); }
    fix.text = 'Give fields a visible border.';
  } else if (r.opacity != null && r.opacity < 0.99 && r.base) {
    // faded with opacity: changing the color alone keeps the fade, so fix the fade
    const full = [r.base[0], r.base[1], r.base[2], r.base[3]];
    const ok = a => C.contrast(C.over([full[0], full[1], full[2], full[3] * a], bgC), bgC) >= target;
    if (ok(1)) {
      let lo = r.opacity, hi = 1;
      for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
      fix.opacity = { now: Math.round(r.opacity * 100), needed: Math.ceil(hi * 100), source: r.opSource };
      fix.text = `It's faded to ${fix.opacity.now}% opacity. Raise it to ${fix.opacity.needed}% or more.`;
    } else {
      const c = C.nearestPassing(C.over(full, bgC), bgC, target);
      if (c) { fix.color = C.hex(c); fix.ratio = C.ratio(C.contrast(c, bgC)); }
      fix.opacity = { now: Math.round(r.opacity * 100), needed: 100, source: r.opSource };
      fix.text = `It's faded to ${fix.opacity.now}% opacity. Remove the fade${c ? ' and use the color below' : ''}.`;
    }
  } else {
    const c = C.nearestPassing(fgC, bgC, target);
    if (c) {
      fix.color = C.hex(c); fix.ratio = C.ratio(C.contrast(c, bgC));
      if (failsAA) { const c2 = C.nearestPassing(fgC, bgC, r.need.aaa); if (c2) fix.aaa = C.hex(c2); }
      fix.palette = paletteFix(fgC, bgC, target);
    } else { fix.text = 'No text color reaches it on this background. Change the background.'; needsInput = true; }
  }
  const what = roleWord(rs);
  const allPlaces = rs.flatMap(x => x.places);
  const onlyOn = allPlaces.every(p => p.includes('· phone')) ? ' on phones' : allPlaces.every(p => p.includes('· desktop')) ? ' on desktop' : '';
  const title = r.image && r.mixed ? `${what} running over two backgrounds` : r.image ? `${what} on a picture` : r.kind === 'link' ? (r.ratio < 1.15 ? 'Links in text look like the text around them' : 'Links in text stand out only by color') :
    `${what}: ${tone(fgC)} on ${tone(C.parse(r.bg))}`;
  const fullTitle = title + (r.image ? onlyOn : '');
  issues.push({
    id: 'a' + (issues.length + 1), priority, kind: r.kind, title: fullTitle,
    ratio: C.ratio(r.ratio), need: C.ratio(target), level: failsAA ? 'AA' : 'AAA',
    fg: r.fg, bg: r.bg, image: r.image, shot: r.shot || null, large: r.large, sizes: [...new Set(rs.map(x => x.sizePx).filter(Boolean))].sort((a, b) => a - b),
    count: rs.length, needsInput,
    fix,
    elements: rs.map(x => ({ text: x.text, page: x.page, scheme: x.scheme, selector: x.path, source: x.source, opacitySource: x.opSource || undefined, places: x.places })),
  });
}
const order = { high: 0, medium: 1, low: 2 };
issues.sort((a, b) => order[a.priority] - order[b.priority] || parseFloat(a.ratio) - parseFloat(b.ratio));
issues.forEach((x, i) => { x.id = 'a' + (i + 1); });

const small = [...smalls.values()].sort((a, b) => a.size - b.size).map(s => ({ ...s, places: [...s.places] }));

const result = {
  site: t.local ? t.local : t.start, date: new Date().toISOString(), pages: urls.map(pathOf), schemes, darkMode: dm.media ? 'checked' : dm.byClass ? 'switched by a class, not checked' : 'none',
  score, counts: { high: issues.filter(i => i.priority === 'high').length, medium: issues.filter(i => i.priority === 'medium').length, low: issues.filter(i => i.priority === 'low').length },
  issues: issues.map(({ shot, ...x }) => x), smallText: small,
};
fs.writeFileSync(out.json, JSON.stringify(result, null, 2));

// ------------------------------------------------------------------ the report
function sampleBox(i) {
  if (i.shot) return `<img class="thumb" src="data:image/png;base64,${i.shot}" alt="">`;
  if (i.kind === 'field') return `<span class="sample" style="background:${i.bg};box-shadow:inset 0 0 0 1px ${i.fg}"></span>`;
  if (i.kind === 'link') { const page = C.luminance(C.parse(i.bg)) > 0.35 ? '#111111' : '#FFFFFF'; return `<span class="sample" style="background:${page}"><span><span style="color:${i.bg}">a</span><span style="color:${i.fg}">b</span><span style="color:${i.bg}">c</span></span></span>`; }
  return `<span class="sample" style="background:${i.bg};color:${i.fg}">Aa</span>`;
}
const sw = c => `<span class="sw" style="background:${c}"></span>`;
function issueRow(i) {
  const fix = [];
  if (i.fix.color) fix.push(`<span class="chip">${sw(i.fix.color)} Use <code>${i.fix.color}</code> · ${i.fix.ratio}</span>`);
  if (i.fix.palette) fix.push(`<span class="chip">${sw(i.fix.palette.hex)} or <code>${esc(i.fix.palette.name)}</code> · ${i.fix.palette.ratio}</span>`);
  const places = i.elements.flatMap(e => e.places.map(p => `“${esc(e.text)}” · ${esc(p)}`));
  const sizes = i.sizes && i.sizes.length ? ` · ${i.sizes.map(s => Math.round(s * 10) / 10 + 'px').join(', ')}` : '';
  return `<div class="item">${sampleBox(i)}<div>
    <p class="what">${esc(i.title)}</p>
    <p class="why">${i.ratio}, needs ${i.need} for ${i.level}${sizes}</p>
    ${i.fix.text ? `<p class="why">${esc(i.fix.text)}</p>` : ''}
    ${fix.length ? `<div class="fix">${fix.join('')}</div>` : ''}
    ${where(places)}
  </div></div>`;
}
const sec = (name, list) => list.length ? `<h2>${name} <span class="n">${list.length}</span></h2><div class="list">${list.map(issueRow).join('')}</div>` : '';
const high = issues.filter(i => i.priority === 'high'), med = issues.filter(i => i.priority === 'medium'), low = issues.filter(i => i.priority === 'low');
const smallRows = small.map(s => `<div class="item no-lead"><div><p class="what">${Math.round(s.size * 10) / 10}px · “${esc(s.text)}”</p><p class="why">${s.tiny ? 'Very small. No rule forbids it, but it is hard to read.' : 'Small for a whole paragraph.'}</p>${where(s.places.map(esc))}</div></div>`).join('');

const body = `
<div class="stats">
  <div class="stat"><div class="n">${score.aa.pct}%</div><div class="k">AA · ${score.aa.pass} of ${score.aa.total} checks pass</div></div>
  <div class="stat"><div class="n">${score.aaa.pct}%</div><div class="k">AAA · ${score.aaa.pass} of ${score.aaa.total} checks pass</div></div>
</div>
<p class="lead">${score.aa.pass === score.aa.total ? 'Every check passes AA.' : 'A site meets AA only when every check passes. The percentage shows how close it is.'}</p>
${sec('Fix first', high)}
${sec('Fix next', med)}
${sec('Only fails AAA', low)}
${small.length ? `<h2>Small text <span class="n">${small.length}</span></h2><div class="list">${smallRows}</div>` : ''}
${!issues.length && !small.length ? '<h2>Nothing to fix</h2>' : ''}
<p class="foot sm">Checked text contrast, field and icon edges, links in text and text size, ${schemes.length > 1 ? 'in light and dark, ' : ''}at desktop and phone width. ${dm.media ? '' : dm.byClass ? 'The site switches to dark with a class, so only light was checked. ' : 'No dark mode found. '}A keyboard and screen reader test still needs a person.</p>
<p class="sm">Pages: ${urls.map(u => esc(pathOf(u))).join(', ')}</p>`;
fs.writeFileSync(out.html, reportPage({ title: 'Accessibility', sub: `${esc(t.name)} · ${plural(urls.length, 'page')} · ${date()}`, body }));

console.log(JSON.stringify({ report: out.html, data: out.json, score: { AA: score.aa.pct + '%', AAA: score.aaa.pct + '%' }, issues: result.counts, smallText: small.length }, null, 2));
