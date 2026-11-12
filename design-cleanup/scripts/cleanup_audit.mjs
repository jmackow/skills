#!/usr/bin/env node
// Design cleanup: near-duplicate colors, text styles, spacing and corners; tokens that repeat, go unused or get
// typed out by hand; and components (buttons, cards, fields, headings) that exist in slightly different versions.
//
//   node cleanup_audit.mjs --url http://localhost:3000 [--pages /,/about] [--max 20] [--out site-reports]
//   node cleanup_audit.mjs --root ./site
//
// Writes site-reports/design-cleanup.html (for people) and design-cleanup.json (for Claude).
import fs from 'node:fs';
import { launch, target, findPages, settle, args, outDir, pathOf } from './lib/browser.mjs';
import * as C from './lib/color.mjs';
import { page as reportPage, esc, plural, where, date } from './lib/report.mjs';
import { INSTALL } from './lib/inpage.mjs';

const opts = args();
const t = await target(opts);
const out = outDir(opts, 'design-cleanup');
const browser = await launch();
const urls = await findPages(browser, t.start, { max: +(opts.max || 20), only: opts.pages, root: t.local });
if (!urls.length) { console.error('No pages found at ' + t.start); process.exit(1); }
console.error(`Checking ${plural(urls.length, 'page')}...`);

// ------------------------------------------------------------------ in the page
function collect() {
  const A = window.__audit;
  const px = A.px;
  const vals = { colors: [], sizes: [], spacing: [], radii: [], families: [], textStyles: [] };
  const comps = [];
  const all = [...document.body.querySelectorAll('*')].slice(0, 6000);
  A.els = [];
  const famOf = f => { let x = f.split(',')[0].trim().replace(/^["']|["']$/g, ''); const m = x.match(/^__(.+?)_[0-9a-f]{4,}$/i); return m ? m[1].replace(/_/g, ' ') : x; };
  for (const el of all) {
    if (el.closest('script,style,noscript,template,svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const s = A.cs(el);
    if (s.display === 'none' || s.visibility !== 'visible') continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const sig = A.sig(el);
    const where = sig;
    const own = A.ownText(el).length > 0;
    const c = A.rgba(s.color), bg = A.rgba(s.backgroundColor);
    if (own && c && c[3] > 0) vals.colors.push({ v: c, prop: 'color', where });
    if (bg && bg[3] > 0) vals.colors.push({ v: bg, prop: 'background', where });
    for (const sd of ['Top', 'Right', 'Bottom', 'Left']) {
      if (px(s['border' + sd + 'Width']) >= 1 && s['border' + sd + 'Style'] !== 'none') { const bc = A.rgba(s['border' + sd + 'Color']); if (bc && bc[3] > 0) { vals.colors.push({ v: bc, prop: 'border', where }); break; } }
    }
    if (own && !el.closest('svg')) {
      const sect = el.closest('section,header,footer,nav,aside,article,form') || el.parentElement;
      vals.sizes.push({ v: px(s.fontSize), where });
      vals.families.push({ v: famOf(s.fontFamily), raw: s.fontFamily, where, section: A.sig(sect).split(' > ').pop() });
      vals.textStyles.push({ family: famOf(s.fontFamily), size: px(s.fontSize), weight: +s.fontWeight || 400,
        line: s.lineHeight === 'normal' ? 'normal' : Math.round(px(s.lineHeight) * 10) / 10, track: s.letterSpacing === 'normal' ? 0 : Math.round(px(s.letterSpacing) * 100) / 100,
        transform: s.textTransform, where, text: A.ownText(el).map(n => n.textContent).join(' ').trim().slice(0, 50) });
    }
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
      const v = px(s[p]);
      if (v > 0 && !(p.startsWith('margin') && v > 400)) vals.spacing.push({ v: Math.round(v * 10) / 10, prop: p.replace(/[A-Z].*/, '').replace('row', 'gap').replace('column', 'gap'), where });
    }
    const rad = px(s.borderTopLeftRadius);
    if (rad > 0 && (alphaOk(bg) || px(s.borderTopWidth) > 0 || /^(IMG|VIDEO)$/.test(el.tagName) || s.overflow !== 'visible')) {
      const anc = []; for (let n = el.parentElement, k = 0; n && k < 4 && n !== document.body; n = n.parentElement, k++) { const r2 = px(A.cs(n).borderTopLeftRadius); if (r2 > 0) anc.push(Math.round(r2 * 10) / 10); }
      vals.radii.push({ v: rad >= Math.min(b.width, b.height) / 2 - 0.5 ? 'pill' : Math.round(rad * 10) / 10, where, anc });
    }

    // components
    const tag = el.tagName;
    let kind = null;
    const filled = alphaOk(bg), bordered = px(s.borderTopWidth) >= 1 && s.borderTopStyle !== 'none';
    const text = (el.innerText || el.value || '').trim();
    if ((tag === 'BUTTON' || (tag === 'INPUT' && /^(submit|button)$/.test(el.type)) || (tag === 'A' && (filled || bordered) && px(s.paddingLeft) >= 8 && /inline|flex|block|grid/.test(s.display) && b.height <= 80)) && text && text.length < 40) kind = 'button';
    else if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !/^(hidden|submit|button|checkbox|radio|range|color|file|image|reset)$/.test(el.type)) kind = 'field';
    else if (/^H[1-4]$/.test(tag)) kind = 'heading-' + tag.toLowerCase();
    else if ((filled || bordered || (s.boxShadow && s.boxShadow !== 'none')) && px(s.borderTopLeftRadius) > 0 && (px(s.paddingTop) >= 12 || el.querySelector('img,picture,video')) && b.width < innerWidth * 0.9 && b.height >= 60 && text && /^(DIV|ARTICLE|LI|A|SECTION|ASIDE|FIGURE)$/.test(tag)) {
      // a card: something like it sits next to it (a sibling or a cousin with the same tag)
      kind = 'card';
    }
    if (kind) {
      const idx = A.els.push(el) - 1;
      const pad = ['Top', 'Right', 'Bottom', 'Left'].map(sd => Math.round(px(s['padding' + sd]) * 10) / 10);
      comps.push({ idx, kind, tag: tag.toLowerCase(), classes: el.getAttribute('class') || '', text: text.replace(/\s+/g, ' ').slice(0, 40), sig, path: A.path(el),
        width: Math.round(b.width), height: Math.round(b.height),
        style: {
          fill: filled ? bg : null, color: c, border: bordered ? { w: px(s.borderTopWidth), c: A.rgba(s.borderTopColor) } : null,
          radius: px(s.borderTopLeftRadius) >= Math.min(b.width, b.height) / 2 - 0.5 ? 'pill' : Math.round(px(s.borderTopLeftRadius) * 10) / 10,
          padding: pad, size: px(s.fontSize), weight: +s.fontWeight || 400, family: famOf(s.fontFamily),
          line: s.lineHeight === 'normal' ? 'normal' : Math.round(px(s.lineHeight) * 10) / 10, track: s.letterSpacing === 'normal' ? 0 : Math.round(px(s.letterSpacing) * 100) / 100,
          shadow: s.boxShadow === 'none' ? null : s.boxShadow, transform: s.textTransform,
        },
        sources: {
          fill: A.source(el, 'background-color'), padding: A.source(el, 'padding-top') || A.source(el, 'padding-left'), size: A.source(el, 'font-size'),
          radius: A.source(el, 'border-top-left-radius'), weight: A.source(el, 'font-weight'), border: A.source(el, 'border-top-color'),
          family: A.source(el, 'font-family'), line: A.source(el, 'line-height'),
        },
      });
    }
  }
  function alphaOk(c) { return !!c && c[3] > 0.05; }

  // CSS as written: hard-coded colors and lengths, and which tokens are referenced
  const written = [];
  const refs = new Set();
  const walk = (rules, file, media) => {
    for (const r of rules) {
      if (r.constructor && r.constructor.name === 'CSSImportRule') { try { walk(r.styleSheet.cssRules, r.styleSheet.href ? new URL(r.styleSheet.href).pathname : file, media); } catch {} continue; }
      if (r.cssRules && !r.selectorText) { try { walk(r.cssRules, file, r.media ? r.media.mediaText : media); } catch {} continue; }
      if (!r.style) continue;
      const text = r.cssText || '';
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) refs.add(m[1]);
      if (!r.selectorText || /(^|,)\s*(:root|html|:host)\b/.test(r.selectorText)) continue;
      for (let i = 0; i < r.style.length; i++) {
        const prop = r.style[i]; if (prop.startsWith('--')) continue;
        const v = r.style.getPropertyValue(prop).trim();
        if (!v || /var\(/.test(v)) continue;
        written.push({ file, selector: r.selectorText, prop, value: v, media: media || null });
      }
    }
  };
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const file = sheet.href ? new URL(sheet.href).pathname : '<style> in the page';
    const built = /\/_next\/|\/_nuxt\/|\/_astro\/|\/build\/|\/dist\/|[.-][0-9a-f]{8,}\.css$|\.min\.css$|webflow\.[\w-]*\.css$/i.test(file);
    walk(rules, file, null);
    if (built) for (const w of written) if (w.file === file) w.built = true;
  }
  for (const el of document.querySelectorAll('[style]')) for (const m of el.getAttribute('style').matchAll(/var\(\s*(--[\w-]+)/g)) refs.add(m[1]);
  const tokens = A.tokens().map(tk => ({ ...tk, rgba: /^(#|rgb|hsl|oklch|oklab|lab|lch|color\()/i.test(tk.value) || /^[a-z]+$/i.test(tk.value) && !/^(auto|none|inherit|initial|normal|bold)$/i.test(tk.value) ? A.rgba(tk.value) : null }));
  return { vals, comps, written, refs: [...refs], tokens };
}

// ------------------------------------------------------------------ run
const V = { colors: [], sizes: [], spacing: [], radii: [], families: [], textStyles: [] };
const comps = [];
let written = [], refs = new Set(), tokens = [];
const seenWritten = new Set();
const seenComp = new Set();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
for (const url of urls) {
  await settle(page, url);
  await page.evaluate(INSTALL);
  const d = await page.evaluate(collect);
  const p = pathOf(url);
  for (const k of Object.keys(V)) for (const x of d.vals[k]) V[k].push({ ...x, page: p });
  for (const w of d.written) { const key = w.file + w.selector + w.prop + w.value + w.media; if (!seenWritten.has(key)) { seenWritten.add(key); written.push(w); } }
  d.refs.forEach(r => refs.add(r));
  if (!tokens.length) tokens = d.tokens;
  // pictures of the components, while the page is open (one per look, so each version gets one)
  const seen = new Set();
  for (const c of d.comps) {
    c.page = p;
    const one = c.path + '|' + c.text;
    if (seenComp.has(one)) continue;
    seenComp.add(one);
    const look = c.kind + JSON.stringify(c.style);
    if (!seen.has(look) && seen.size < 80) {
      seen.add(look);
      const rect = await page.evaluate(i => {
        const el = window.__audit.els[i]; el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, c.idx);
      if (rect.width > 0 && rect.height > 0 && rect.width <= 1440 && rect.height <= 900) {
        const pad = 8;
        const clip = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: Math.min(1440, rect.width + pad * 2), height: Math.min(900, rect.height + pad * 2) };
        clip.width = Math.min(clip.width, 1440 - clip.x); clip.height = Math.min(clip.height, 900 - clip.y);
        const png = await page.screenshot({ clip, animations: 'disabled' }).catch(() => null);
        if (png) c.shot = png.toString('base64');
      }
    }
    comps.push(c);
  }
  process.stderr.write('.');
}
process.stderr.write('\n');
const darkTokens = new Set();
if (tokens.length) {
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const dp = await dctx.newPage();
  await settle(dp, urls[0]);
  await dp.evaluate(INSTALL);
  const dt = await dp.evaluate(() => window.__audit.tokens().map(x => [x.name, x.value]));
  const light = new Map(tokens.map(x => [x.name, x.value]));
  for (const [n, v] of dt) if (light.has(n) && light.get(n) !== v) darkTokens.add(n);
  await dctx.close();
}
await browser.close();
t.close();

// ------------------------------------------------------------------ helpers
const count = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); const o = m.get(k) || { key: k, n: 0, items: [] }; o.n++; if (o.items.length < 400) o.items.push(x); m.set(k, o); } return [...m.values()].sort((a, b) => b.n - a.n); };
const placesOf = items => [...new Set(items.map(x => `${x.where} · ${x.page}`))];
const colorKey = c => C.hex(c) + (c[3] < 0.995 ? ' ' + Math.round(c[3] * 100) + '%' : '');
const tokenByColor = new Map();
for (const tk of tokens) if (tk.rgba && tk.rgba[3] > 0) { const k = colorKey(tk.rgba); if (!tokenByColor.has(k)) tokenByColor.set(k, []); tokenByColor.get(k).push(tk.name); }
const pxOf = v => { const m = String(v).trim().match(/^(-?\d*\.?\d+)(px|rem)$/); return m ? (m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1])) : null; };
const findings = [];
function runs(list, close) {
  const sorted = [...list].sort((a, b) => a.v - b.v);
  const out = [];
  let cur = [];
  for (const x of sorted) { if (cur.length && close(x.v, cur[0].v)) cur.push(x); else { if (cur.length > 1) out.push(cur); cur = [x]; } }
  if (cur.length > 1) out.push(cur);
  return out;
}
let fid = 0;
const add = f => { f.id = 'c' + (++fid); findings.push(f); return f; };

// ------------------------------------------------------------------ colors
const colorCounts = count(V.colors, x => colorKey(x.v));
const colorList = colorCounts.map(c => ({ key: c.key, hex: c.key.split(' ')[0], n: c.n, rgba: c.items[0].v, tokens: tokenByColor.get(c.key) || [], items: c.items }));
// near-identical: closer than ~3 in OKLab (x100), same opacity
{
  const used = new Set();
  for (const a of colorList) {
    if (used.has(a.key)) continue;
    // two colors that are each their own token were told apart on purpose (white and a warm tint): not a duplicate
    const near = colorList.filter(b => b !== a && !used.has(b.key) && !(a.tokens.length && b.tokens.length) && Math.abs(a.rgba[3] - b.rgba[3]) < 0.03 && C.distance(a.rgba, b.rgba) < 3);
    if (!near.length) continue;
    const members = [a, ...near];
    members.forEach(m => used.add(m.key));
    const keep = members.find(m => m.tokens.length) || members[0];
    add({ area: 'colors', type: 'near-colors', title: `${members.length} colors that look the same`,
      detail: members.map(m => `${m.key}${m.tokens.length ? ' (' + m.tokens.join(', ') + ')' : ''} · ${plural(m.n, 'use')}`).join(', '),
      suggestion: `Use ${keep.key}${keep.tokens.length ? ' (' + keep.tokens[0] + ')' : ''} for all of them.`,
      swatches: members.map(m => m.key), keep: keep.key, keepToken: keep.tokens[0] || null,
      places: members.flatMap(m => placesOf(m.items).map(p => `${m.key} · ${p}`)) });
  }
}
// tokens: same value twice, nearly the same, never used
{
  const colorTokens = tokens.filter(tk => tk.rgba && tk.rgba[3] > 0 && !/var\(/.test(tk.raw));
  const groups = new Map();
  for (const tk of colorTokens) { const k = colorKey(tk.rgba); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(tk); }
  for (const [k, list] of groups) if (list.length > 1) add({ area: 'tokens', type: 'duplicate-tokens', title: `${list.length} tokens with the same color`,
    detail: `${list.map(x => x.name).join(', ')}: all ${k}.`, suggestion: `Keep ${list[0].name}. Point the others at it, or replace them.`, swatches: [k],
    tokens: list.map(x => ({ name: x.name, file: x.file })) });
  // groups of values that look alike, each listed once
  const vals = [...groups.entries()];
  const done = new Set();
  for (let i = 0; i < vals.length; i++) {
    if (done.has(i)) continue;
    const cluster = [i];
    for (let j = i + 1; j < vals.length; j++) if (!done.has(j) && cluster.some(c => { const a = vals[c][1][0].rgba, b = vals[j][1][0].rgba; return Math.abs(a[3] - b[3]) < 0.03 && C.distance(a, b) < 2.5; })) cluster.push(j);
    if (cluster.length < 2) continue;
    cluster.forEach(c => done.add(c));
    const parts = cluster.map(c => `${vals[c][1].map(x => x.name).join(', ')} ${vals[c][0]}`);
    add({ area: 'tokens', type: 'near-tokens', title: `${cluster.length} token colors that are hard to tell apart`,
      detail: parts.join(' · '), suggestion: 'Check whether they are meant to be one color.', swatches: cluster.map(c => vals[c][0]),
      tokens: cluster.flatMap(c => vals[c][1]).map(x => ({ name: x.name, file: x.file })) });
  }
  const unused = tokens.filter(tk => !refs.has(tk.name));
  if (unused.length) add({ area: 'tokens', type: 'unused-tokens', title: `${plural(unused.length, 'token')} not used on the checked pages`,
    detail: unused.map(x => x.name).join(', '), suggestion: 'Scripts or other pages may use them. If not, remove them.',
    tokens: unused.map(x => ({ name: x.name, file: x.file, value: x.value })) });
}
// values typed by hand that a token already holds
{
  const colorProps = /color|background|border|fill|stroke|outline|shadow/;
  const hits = [];
  const lenTokens = tokens.map(tk => ({ ...tk, px: pxOf(tk.value) })).filter(tk => tk.px != null && tk.px > 0);
  const family = name => /space|spacing|gap|gutter|pad|margin|inset/i.test(name) ? 'space' : /radius|round|corner/i.test(name) ? 'radius' : /font-size|text-|fs-|size-(xs|sm|md|lg|xl)|type/i.test(name) ? 'type' : null;
  const propFamily = p => /^(padding|margin|gap|row-gap|column-gap|top|left|right|bottom|inset)/.test(p) ? 'space' : /radius/.test(p) ? 'radius' : p === 'font-size' ? 'type' : null;
  // a token named for backgrounds isn't for text, and the other way round
  const role = n => /\b(bg|background|surface|canvas|paper|backdrop)\b|-bg\b|bg-/i.test(n) ? 'bg' : /\b(fg|text|ink|foreground|content|heading|body|copy)\b|-fg\b|text-/i.test(n) ? 'fg' : /border|stroke|outline|divider|line/i.test(n) ? 'line' : null;
  const propRole = p => /^background/.test(p) ? 'bg' : p === 'color' ? 'fg' : /border|outline/.test(p) ? 'line' : null;
  const fits = (name, prop) => !role(name) || !propRole(prop) || role(name) === propRole(prop);
  const names4 = c => { const h = C.hex(c).toLowerCase(); const short = /^#(.)\1(.)\2(.)\3$/.test(h) ? '#' + h[1] + h[3] + h[5] : null; return [h, short, `rgb(${c[0]}, ${c[1]}, ${c[2]})`].filter(Boolean); };
  for (const w of written) {
    if (w.built) continue;
    if (colorProps.test(w.prop)) {
      for (const m of w.value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) {
        const c = C.parse(m[0]); if (!c) continue;
        const names = (tokenByColor.get(colorKey(c)) || []).filter(n => !darkTokens.has(n) && fits(n, w.prop));
        if (names.length) hits.push({ ...w, literal: c[3] < 1 ? m[0] : C.hex(c).toLowerCase(), writtenAs: c[3] < 1 ? [m[0]] : names4(c), token: names[0] });
      }
    } else {
      const fam = propFamily(w.prop); if (!fam) continue;
      const v = pxOf(w.value); if (v == null || v === 0) continue;
      const tk = lenTokens.find(x => family(x.name) === fam && Math.abs(x.px - v) < 0.01);
      if (tk && !darkTokens.has(tk.name)) hits.push({ ...w, literal: w.value, writtenAs: [w.value], token: tk.name });
    }
  }
  const uniq = count(hits, h => `${h.file}|${h.selector}|${h.prop}|${h.literal}`).map(x => x.items[0]);
  if (uniq.length) add({ area: 'tokens', type: 'hardcoded', title: `${plural(uniq.length, 'value')} typed out instead of using a token`,
    detail: [...new Set(uniq.map(h => `${h.literal} → ${h.token}`))].slice(0, 8).join(', '), suggestion: 'Swap each one for its token.',
    places: uniq.map(h => `${h.selector} { ${h.prop}: ${h.literal} } → var(${h.token}) · ${h.file}`), edits: uniq.map(h => ({ file: h.file, selector: h.selector, prop: h.prop, from: h.literal, writtenAs: h.writtenAs, to: `var(${h.token})`, media: h.media })) });
}

// ------------------------------------------------------------------ text
const famCounts = count(V.families, x => x.v);
const mono = /mono|code|courier|consolas|menlo/i;
const mainFams = famCounts.filter(f => !mono.test(f.key));
const sectionName = sig => { const [tag, ...cls] = String(sig).split('#')[0].split('.'); const c = cls.find(x => x.length > 2 && !/^(w-|is-|has-|color-scheme|padding|container|wrapper|layout|section$)/.test(x) && !/\d{2,}/.test(x)); return 'the ' + (c ? c.replace(/^section[_-]?/, '').replace(/\d+/g, '').replace(/__|--|[_-]+/g, ' ').trim() + ' ' : '') + ({ section: 'section', header: 'header', footer: 'footer', nav: 'navigation', form: 'form', aside: 'sidebar', article: 'article' }[tag] || 'part'); };
const sectionsOf = f => new Set(f.items.map(x => x.section + ' · ' + x.page));
const odd = mainFams.slice(1).filter((f, i) => i >= 1 || f.n < mainFams[0].n * 0.1 || sectionsOf(f).size <= 2);
if (odd.length) {
  add({ area: 'text', type: 'fonts', title: `${plural(mainFams.length, 'font')} for running text`, detail: mainFams.map(f => `${f.key} · ${plural(f.n, 'use')}`).join(', '),
    suggestion: `${odd.map(f => `${f.key} is only used in ${[...new Set(f.items.map(x => sectionName(x.section) + ' on ' + x.page))].slice(0, 3).join(', ')}`).join('; ')}. Switch ${odd.length === 1 ? 'it' : 'them'} to ${mainFams[0].key}, unless it's on purpose.`,
    places: odd.flatMap(f => placesOf(f.items).map(p => `${f.key} · ${p}`)) });
}
const styleKey = s => `${s.family}|${s.size}|${s.weight}|${s.line}|${s.track}|${s.transform}`;
const styles = count(V.textStyles, styleKey).map(s => ({ ...s.items[0], n: s.n, items: s.items, key: s.key }));
{
  // two text styles a pixel or two apart, same font and weight
  const used = new Set();
  for (const a of styles) {
    if (used.has(a.key)) continue;
    const near = styles.filter(b => b !== a && !used.has(b.key) && b.family === a.family && b.weight === a.weight && b.transform === a.transform && (
      (b.size !== a.size && Math.abs(b.size - a.size) <= Math.max(1, a.size * 0.06)) ||
      (b.size === a.size && b.line !== a.line && a.line !== 'normal' && b.line !== 'normal' && Math.abs(b.line - a.line) <= 2) ||
      (b.size === a.size && b.line === a.line && b.track !== a.track && Math.abs(b.track - a.track) <= 0.3)));
    if (!near.length) continue;
    const members = [a, ...near].sort((x, y) => y.n - x.n);
    members.forEach(m => used.add(m.key));
    const fmt = s => `${s.size}px/${s.line === 'normal' ? 'auto' : s.line}${s.track ? ' ' + s.track + 'px' : ''}`;
    add({ area: 'text', type: 'near-text-styles', title: `${members.length} almost identical text styles`, detail: `${a.family} ${a.weight}: ` + members.map(m => `${fmt(m)} · ${plural(m.n, 'use')}`).join(', '),
      suggestion: `Use ${fmt(members[0])} for all of them.`, keep: members[0], places: members.flatMap(m => [...new Map(m.items.map(x => [`${x.where}|${x.page}`, `${fmt(m)} “${x.text}” · ${x.page}`])).values()]) });
  }
}
const sizeList = count(V.sizes, x => x.v).map(s => ({ v: s.key, n: s.n })).sort((a, b) => a.v - b.v);

// ------------------------------------------------------------------ spacing and corners
const spaceCounts = count(V.spacing, x => x.v).map(s => ({ v: s.key, n: s.n, items: s.items })).sort((a, b) => a.v - b.v);
{
  const offScale = spaceCounts.filter(s => Number.isInteger(s.v) && s.v >= 3 && s.v <= 64 && s.v % 4 !== 0 && !(s.v < 8 && s.v % 2 === 0));
  if (offScale.length) add({ area: 'spacing', type: 'off-scale', title: `${plural(offScale.length, 'spacing value')} off the 4px grid`,
    detail: offScale.map(s => `${s.v}px · ${plural(s.n, 'use')}`).join(', '), suggestion: `Round each to the nearest step of 4: ${offScale.map(s => `${s.v} → ${Math.round(s.v / 4) * 4}`).join(', ')}.`,
    places: offScale.flatMap(s => placesOf(s.items).map(p => `${s.v}px ${s.items[0].prop} · ${p}`)) });
  // big values a few pixels apart (section spacing): 118, 120, 128
  for (const members of runs(spaceCounts.filter(s => s.v >= 40 && Number.isInteger(s.v)), (v, min) => v - min <= min * 0.1)) {
    const keep = [...members].sort((x, y) => y.n - x.n)[0];
    add({ area: 'spacing', type: 'near-spacing', title: `Big spacing in ${members.length} close sizes`, detail: members.map(m => `${m.v}px · ${plural(m.n, 'use')}`).join(', '),
      suggestion: `Use ${keep.v}px for all of them.`, places: members.flatMap(m => placesOf(m.items).map(p => `${m.v}px ${m.items[0].prop} · ${p}`)) });
  }
}
const radCounts = count(V.radii, x => x.v).map(s => ({ v: s.key, n: s.n, items: s.items }));
for (let members of runs(radCounts.filter(r => r.v !== 'pill' && r.v >= 4), (v, min) => v - min <= Math.max(2, min * 0.34))) {
  members = members.filter(m => !m.items.every(it => (it.anc || []).some(a => a !== m.v && members.some(o => o.v === a))));
  if (members.length < 2) continue;
  const keep = [...members].sort((x, y) => y.n - x.n)[0];
  add({ area: 'corners', type: 'near-radii', title: `Corners in ${members.length} close sizes`, detail: members.map(m => `${m.v}px · ${plural(m.n, 'use')}`).join(', '),
    suggestion: `Use ${keep.v}px for all of them.`, places: members.flatMap(m => placesOf(m.items).map(p => `${m.v}px · ${p}`)) });
}

// ------------------------------------------------------------------ components
const KIND_WORD = { button: 'Button', field: 'Form field', card: 'Card', 'heading-h1': 'Heading 1', 'heading-h2': 'Heading 2', 'heading-h3': 'Heading 3', 'heading-h4': 'Heading 4' };
const looks = new Map();
for (const c of comps) {
  // a heading's color follows its section's background, so it isn't part of its look; a card's look is its surface
  const look = c.kind.startsWith('heading') ? { ...c.style, color: null, fill: null }
    : c.kind === 'card' ? { fill: c.style.fill, border: c.style.border, radius: c.style.radius, shadow: c.style.shadow, padding: c.style.padding } : c.style;
  const key = c.kind + '|' + JSON.stringify(look);
  if (!looks.has(key)) looks.set(key, { kind: c.kind, style: c.style, uses: [], shot: null, sources: c.sources });
  const l = looks.get(key); l.uses.push(c); if (!l.shot && c.shot) l.shot = c.shot;
}
const lookList = [...looks.values()];
const pad = p => p[0] === p[2] && p[1] === p[3] ? (p[0] === p[1] ? `${p[0]}` : `${p[0]} ${p[1]}`) : p.join(' ');
function near(a, b) {
  const s = a.style, t = b.style;
  if (a.kind !== b.kind) return false;
  const fillD = s.fill && t.fill ? C.distance(s.fill, t.fill) : (s.fill || t.fill ? 99 : 0);
  if (a.kind.startsWith('heading')) return s.family === t.family && Math.abs(s.size - t.size) <= Math.max(1, s.size * 0.06) && Math.abs(s.weight - t.weight) <= 100;
  if (fillD > 6) return false;
  if (a.kind === 'card') {
    // same surface color and close corners: the same kind of card, even if one has a border
    const rr = s.radius === 'pill' || t.radius === 'pill' ? 99 : Math.abs(s.radius - t.radius);
    return !!s.fill && !!t.fill && rr <= 8;
  }
  if (!!s.border !== !!t.border) return false;
  if (s.color && t.color && C.distance(s.color, t.color) > 8) return false;
  if (Math.abs(s.size - t.size) > 2) return false;
  const pd = s.padding.map((v, i) => Math.abs(v - t.padding[i]));
  if (Math.max(...pd) > (a.kind === 'card' ? 12 : 6)) return false;
  const rr = (s.radius === 'pill' || t.radius === 'pill') ? (s.radius === t.radius || [s.radius, t.radius].some(r => r !== 'pill' && r >= 20) ? 0 : 99) : Math.abs(s.radius - t.radius);
  return rr <= (a.kind === 'card' ? 8 : 6);
}
function diffs(members) {
  const props = [];
  const f = (name, get, show) => { const vals = members.map(m => show(get(m.style))); if (new Set(vals).size > 1) props.push(name); };
  const heading = members[0].kind.startsWith('heading'), card = members[0].kind === 'card';
  if (!heading) f('fill', s => s.fill, v => v ? colorKey(v) : 'none');
  if (!heading && !card) f('text color', s => s.color, v => v ? colorKey(v) : '');
  if (card) { f('corners', s => s.radius, v => v); f('border', s => s.border, v => v ? v.w + ' ' + colorKey(v.c) : 'none'); f('shadow', s => s.shadow, v => v || 'none'); return props; }
  f('padding', s => s.padding, v => pad(v));
  f('font size', s => s.size, v => v);
  f('weight', s => s.weight, v => v);
  f('font', s => s.family, v => v);
  f('line height', s => s.line, v => v);
  f('corners', s => s.radius, v => v);
  f('border', s => s.border, v => v ? v.w + ' ' + colorKey(v.c) : 'none');
  f('shadow', s => s.shadow, v => v || 'none');
  f('letter spacing', s => s.track, v => v);
  return props;
}
const describeLook = (l, props) => {
  const s = l.style, out = [];
  for (const p of props) {
    if (p === 'fill') out.push(`fill ${s.fill ? colorKey(s.fill) : 'none'}`);
    if (p === 'text color') out.push(`text ${s.color ? colorKey(s.color) : ''}`);
    if (p === 'padding') out.push(`padding ${pad(s.padding)}`);
    if (p === 'font size') out.push(`${s.size}px`);
    if (p === 'weight') out.push(`weight ${s.weight}`);
    if (p === 'font') out.push(s.family);
    if (p === 'line height') out.push(`line ${s.line}`);
    if (p === 'corners') out.push(`corners ${s.radius === 'pill' ? 'round' : s.radius + 'px'}`);
    if (p === 'border') out.push(s.border ? `border ${s.border.w}px ${colorKey(s.border.c)}` : 'no border');
    if (p === 'shadow') out.push(s.shadow ? 'shadow' : 'no shadow');
    if (p === 'letter spacing') out.push(`spacing ${s.track}px`);
  }
  return out;
};
{
  const used = new Set();
  for (const a of lookList) {
    if (used.has(a)) continue;
    const cluster = [a];
    const seeds = a.kind.startsWith('heading') ? 1 : Infinity; // headings: only versions close to the first, so 16, 18 and 20 don't chain
    for (let i = 0; i < cluster.length && i < seeds; i++) for (const b of lookList) if (!used.has(b) && !cluster.includes(b) && near(cluster[i], b)) cluster.push(b);
    if (cluster.length < 2) continue;
    cluster.forEach(m => used.add(m));
    cluster.sort((x, y) => y.uses.length - x.uses.length);
    const props = diffs(cluster);
    if (!props.length) { cluster.slice(1).forEach(m => used.delete(m)); continue; }
    const word = KIND_WORD[a.kind];
    add({ area: 'components', type: 'component-versions', kind: a.kind, title: `${word}: ${cluster.length} versions`,
      detail: `They differ in ${props.join(', ')}.`, suggestion: `Make them all like the first one (used ${plural(cluster[0].uses.length, 'time')}).`,
      variants: cluster.map(l => ({
        uses: l.uses.length, shot: l.shot, look: describeLook(l, props),
        examples: l.uses.slice(0, 12).map(u => ({ text: u.text, page: u.page, classes: u.classes, selector: u.path })),
        sources: Object.fromEntries(Object.entries(l.sources).filter(([k, v]) => v && props.some(p => p.startsWith(k === 'fill' ? 'fill' : k === 'size' ? 'font size' : k === 'radius' ? 'corners' : k === 'line' ? 'line' : k === 'family' ? 'font' : k)))),
        style: l.style,
      })),
      places: cluster.flatMap(l => l.uses.map(u => `“${u.text}” · ${u.page} · ${u.classes ? '.' + u.classes.trim().split(/\s+/).join('.') : u.tag}`)) });
  }
}

// ------------------------------------------------------------------ out
const AREA_ORDER = ['components', 'colors', 'tokens', 'text', 'spacing', 'corners'];
findings.sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
const inventory = {
  colors: colorList.map(c => ({ color: c.key, uses: c.n, tokens: c.tokens })),
  fontSizes: sizeList, textStyles: styles.map(s => ({ family: s.family, size: s.size, weight: s.weight, line: s.line, track: s.track, transform: s.transform, uses: s.n })),
  spacing: spaceCounts.map(s => ({ value: s.v, uses: s.n })), radii: radCounts.map(r => ({ value: r.v, uses: r.n })), fonts: famCounts.map(f => ({ font: f.key, uses: f.n })),
};
const result = { site: t.local || t.start, date: new Date().toISOString(), pages: urls.map(pathOf), inventory,
  findings: findings.map(f => ({ ...f, variants: f.variants ? f.variants.map(({ shot, ...v }) => v) : undefined })) };
fs.writeFileSync(out.json, JSON.stringify(result, null, 2));

// ------------------------------------------------------------------ report
const sw = c => `<span class="sw" style="background:${c.split(' ')[0]};opacity:${c.includes('%') ? parseInt(c.split(' ')[1]) / 100 : 1}"></span>`;
function row(f) {
  const variants = f.variants ? `<div class="variants">${f.variants.map((v, i) => `<div class="variant"><div class="pic">${v.shot ? `<img src="data:image/png;base64,${v.shot}" alt="">` : ''}</div>
    <p class="sm"><b>${i === 0 ? 'Most used' : 'Version ' + (i + 1)}</b> · ${plural(v.uses, 'use')}</p><p class="sm">${esc(v.look.join(' · '))}</p></div>`).join('')}</div>` : '';
  const swatches = f.swatches ? `<div class="fix">${f.swatches.map(s => `<span class="chip">${sw(s)} <code>${esc(s)}</code></span>`).join('')}</div>` : '';
  return `<div class="item no-lead"><div><p class="what">${esc(f.title)}</p><p class="why">${esc(f.detail)}</p>${swatches}${variants}<p class="why">${esc(f.suggestion)}</p>${where((f.places || []).map(esc))}</div></div>`;
}
const AREA_NAME = { components: 'Components', colors: 'Colors', tokens: 'Tokens', text: 'Text', spacing: 'Spacing', corners: 'Corners' };
let body = `<div class="stats">
  <div class="stat"><div class="n">${colorList.length}</div><div class="k">colors in use</div></div>
  <div class="stat"><div class="n">${styles.length}</div><div class="k">text styles in use</div></div>
  <div class="stat"><div class="n">${spaceCounts.length}</div><div class="k">spacing values in use</div></div>
</div>`;
for (const area of AREA_ORDER) {
  const list = findings.filter(f => f.area === area);
  if (list.length) body += `<h2>${AREA_NAME[area]} <span class="n">${list.length}</span></h2><div class="list">${list.map(row).join('')}</div>`;
}
if (!findings.length) body += '<h2>Nothing to clean up</h2>';
body += `<p class="foot sm">Measured at desktop width, in light mode. Pages: ${urls.map(u => esc(pathOf(u))).join(', ')}</p>`;
body += `<h2>Text styles in use <span class="n">${styles.length}</span></h2><div class="list"><div class="item no-lead"><table><tr><th>Font</th><th>Size</th><th>Line</th><th>Weight</th><th>Uses</th></tr>${styles.map(s => `<tr><td>${esc(s.family)}</td><td>${s.size}px</td><td>${s.line === 'normal' ? 'auto' : s.line + 'px'}</td><td>${s.weight}</td><td>${s.n}</td></tr>`).join('')}</table></div></div>`;
body += `<h2>Colors in use <span class="n">${colorList.length}</span></h2><div class="list"><div class="item no-lead"><table><tr><th>Color</th><th>Token</th><th>Uses</th></tr>${colorList.map(c => `<tr><td>${sw(c.key)} <code>${esc(c.key)}</code></td><td>${esc(c.tokens.join(', '))}</td><td>${c.n}</td></tr>`).join('')}</table></div></div>`;
fs.writeFileSync(out.html, reportPage({ title: 'Design cleanup', sub: `${esc(t.name)} · ${plural(urls.length, 'page')} · ${date()}`, body }));

const byArea = Object.fromEntries(AREA_ORDER.map(a => [a, findings.filter(f => f.area === a).length]));
console.log(JSON.stringify({ report: out.html, data: out.json, findings: byArea, inUse: { colors: colorList.length, textStyles: styles.length, spacingValues: spaceCounts.length } }, null, 2));
