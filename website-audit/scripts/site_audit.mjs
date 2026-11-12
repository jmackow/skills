#!/usr/bin/env node
// Website audit: links that go nowhere, to a homepage instead of a profile, or to missing pages; the 404 page;
// alt text; favicon; privacy and terms pages; cookie banner; titles, descriptions and share images; layouts that
// break, hide or cut things off at 375, 768, 1024 and 1440; stretched images; script errors and missing files.
// It also saves each page's text for a spelling check.
//
//   node site_audit.mjs --url http://localhost:3000 [--pages /,/about] [--max 20] [--no-external] [--out site-reports]
//   node site_audit.mjs --root ./site
//   node site_audit.mjs --report-only --typos typos.json [--out site-reports]   (adds the spelling check to the report)
//
// Writes site-reports/website-audit.html, website-audit.json (for Claude), site-text.md (the words on each page).
import fs from 'node:fs';
import path from 'node:path';
import { launch, target, findPages, settle, args, outDir, pathOf } from './lib/browser.mjs';
import { page as reportPage, esc, plural, where, date } from './lib/report.mjs';
import { INSTALL } from './lib/inpage.mjs';

const opts = args();
const out = outDir(opts, 'website-audit');
const shotsFile = path.join(out.dir, '.website-audit-shots.json');
const textFile = path.join(out.dir, 'site-text.md');

if (opts['report-only']) {
  const data = JSON.parse(fs.readFileSync(out.json, 'utf8'));
  const shots = fs.existsSync(shotsFile) ? JSON.parse(fs.readFileSync(shotsFile, 'utf8')) : {};
  if (opts.typos) addTypos(data, JSON.parse(fs.readFileSync(opts.typos, 'utf8')));
  fs.writeFileSync(out.json, JSON.stringify(data, null, 2));
  render(data, shots);
  summary(data);
  process.exit(0);
}

const t = await target(opts);
const browser = await launch();
const urls = await findPages(browser, t.start, { max: +(opts.max || 20), only: opts.pages, root: t.local });
if (!urls.length) { console.error('No pages found at ' + t.start); process.exit(1); }
console.error(`Checking ${plural(urls.length, 'page')}...`);

const issues = [];
const shots = {};
const passed = [];
let sid = 0;
const shot = b64 => { if (!b64) return null; const id = 's' + (++sid); shots[id] = b64; return id; };
const issue = o => { issues.push(o); return o; };

// ------------------------------------------------------------------ desktop pass: links, images, meta, files
const SOCIAL = {
  'github.com': p => p.split('/').filter(Boolean).length === 0, 'x.com': p => /^\/?(home)?\/?$/.test(p), 'twitter.com': p => /^\/?(home)?\/?$/.test(p),
  'facebook.com': p => p === '/' || p === '', 'instagram.com': p => p === '/' || p === '', 'linkedin.com': p => /^\/?((in|company)\/?)?$/.test(p),
  'youtube.com': p => p === '/' || p === '', 'tiktok.com': p => p === '/' || p === '', 'dribbble.com': p => p === '/' || p === '', 'behance.net': p => p === '/' || p === '',
  'medium.com': p => p === '/' || p === '', 'threads.net': p => p === '/' || p === '', 'threads.com': p => p === '/' || p === '', 'pinterest.com': p => p === '/' || p === '',
  'discord.com': p => p === '/' || p === '', 'discord.gg': p => p === '/' || p === '', 't.me': p => p === '/' || p === '', 'bsky.app': p => p === '/' || p === '',
  'figma.com': p => p === '/' || p === '', 'producthunt.com': p => p === '/' || p === '', 'vimeo.com': p => p === '/' || p === '',
};
const PLACEHOLDER = /^(https?:\/\/)?(www\.)?(example\.(com|org)|localhost|127\.0\.0\.1|yourdomain|your-?site|link\.com|url\.com|test\.com)(\/|$)|your[-_ ]?(link|url|profile)/i;
const TRACKERS = [
  [/googletagmanager\.com|google-analytics\.com|gtag\/js/, 'Google Analytics / Tag Manager'], [/connect\.facebook\.net|facebook\.com\/tr/, 'Meta Pixel'],
  [/hotjar\.com/, 'Hotjar'], [/clarity\.ms/, 'Microsoft Clarity'], [/snap\.licdn\.com|linkedin\.com\/px/, 'LinkedIn Insight'], [/analytics\.tiktok\.com/, 'TikTok Pixel'],
  [/cdn\.segment\.com/, 'Segment'], [/mixpanel\.com/, 'Mixpanel'], [/js\.hs-scripts\.com|hs-analytics/, 'HubSpot'], [/static\.ads-twitter\.com/, 'X Pixel'],
  [/youtube\.com\/embed/, 'YouTube embed'], [/doubleclick\.net/, 'Google Ads'], [/intercom\.io|widget\.intercom/, 'Intercom'],
];
const CMP = /cookiebot|onetrust|cookielaw|cookieyes|iubenda|termly|usercentrics|klaro|osano|complianz|quantcast|didomi|axeptio|tarteaucitron|cookie-script|cookiefirst|consentmanager/i;

const linkRecords = [];  // every link once per page
const pageInfo = [];
const pageText = [];
const resourceFails = new Map();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failedOn = new Map();
page.on('response', r => {
  const u = r.url();
  if (r.status() >= 400 && r.request().resourceType() !== 'document') failedOn.set(u, { status: r.status(), type: r.request().resourceType() });
});
page.on('requestfailed', r => failedOn.set(r.url(), { status: 0, type: r.resourceType(), error: r.failure() && r.failure().errorText }));
const trackedOn = new Set();
page.on('request', r => { for (const [re, name] of TRACKERS) if (re.test(r.url())) trackedOn.add(name); });

for (const url of urls) {
  failedOn.clear(); trackedOn.clear();
  await ctx.clearCookies();
  const { res, errors } = await settle(page, url);
  await page.evaluate(INSTALL);
  const p = pathOf(url);
  const info = await page.evaluate(() => {
    const A = window.__audit;
    const meta = n => { const m = document.querySelector(`meta[name="${n}"],meta[property="${n}"]`); return m ? m.getAttribute('content') : null; };
    const links = [...document.querySelectorAll('a')].map(a => {
      const raw = a.getAttribute('href') ?? a.getAttribute('xlink:href');
      let href = ''; try { href = raw == null ? '' : new URL(raw, location.href).href; } catch {}
      return {
      raw, href, text: (A.text(a).trim() || a.getAttribute('aria-label') || a.getAttribute('title') || (a.querySelector('img') && a.querySelector('img').alt) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      // a link that works as a button: scripts handle it (role, toggles, data hooks)
      button: a.getAttribute('role') === 'button' || a.hasAttribute('aria-controls') || a.hasAttribute('aria-expanded') || a.hasAttribute('onclick') || [...a.attributes].some(x => /^(data-(toggle|bs-|action|target|w-)|fs-)/i.test(x.name)),
      hidden: A.hidden(a), path: A.path(a), inNav: !!a.closest('nav,header'), inFooter: !!a.closest('footer'),
      icon: !A.text(a).trim() && !!a.querySelector('svg,img'),
    }; });
    const ids = new Set([...document.querySelectorAll('[id]')].map(e => e.id).concat([...document.querySelectorAll('a[name]')].map(e => e.name)));
    const imgs = [...document.querySelectorAll('img')].map(img => {
      const r = img.getBoundingClientRect(), s = getComputedStyle(img);
      const entry = performance.getEntriesByName(img.currentSrc || img.src)[0];
      return { src: img.currentSrc || img.src, raw: img.getAttribute('src'), alt: img.getAttribute('alt'), hasAlt: img.hasAttribute('alt'), w: r.width, h: r.height,
        nw: img.naturalWidth, nh: img.naturalHeight, complete: img.complete, fit: s.objectFit, hidden: A.hidden(img), path: A.path(img),
        inLink: (l => !!l && !A.text(l).trim() && !l.getAttribute('aria-label') && !l.getAttribute('aria-labelledby') && !l.getAttribute('title'))(img.closest('a')), bytes: entry ? entry.transferSize || entry.encodedBodySize || 0 : 0,
        decorativeRole: img.getAttribute('role') === 'presentation' || img.getAttribute('aria-hidden') === 'true' };
    });
    const icons = [...document.querySelectorAll('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"]')].map(l => ({ rel: l.rel, href: l.href }));
    const scripts = [...document.querySelectorAll('script[src],iframe[src]')].map(s => s.src);
    const inline = [...document.querySelectorAll('script:not([src])')].map(s => s.textContent.slice(0, 2000)).join('\n');
    // a cookie banner: a known consent tool, or something fixed/dialog-like that talks about cookies and has a button
    let banner = false;
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (!/fixed|sticky/.test(s.position) && el.tagName !== 'DIALOG' && el.getAttribute('role') !== 'dialog') continue;
      if (A.hidden(el)) continue;
      if (/cookie|ciasteczk|consent|zgod|rgpd|gdpr|privacy choices/i.test(el.innerText || '') && el.querySelector('button,a,[role=button]')) { banner = true; break; }
    }
    const text = (document.querySelector('main') || document.body).innerText;
    return {
      title: document.title, description: meta('description'), ogTitle: meta('og:title'), ogDescription: meta('og:description'), ogImage: meta('og:image'),
      twitterCard: meta('twitter:card'), lang: document.documentElement.getAttribute('lang'), h1: [...document.querySelectorAll('h1')].filter(h => A.rendered(h)).length,
      links, ids: [...ids], imgs, icons, scripts, inline, banner, cmp: [...document.querySelectorAll('script[src]')].some(s => /cookiebot|onetrust|cookielaw|cookieyes|iubenda|termly|usercentrics|klaro|osano|complianz|quantcast|didomi|axeptio|tarteaucitron|cookie-script|cookiefirst|consentmanager/i.test(s.src)),
      text, fullText: document.body.innerText,
      sheets: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href),
    };
  });
  info.page = p; info.url = url; info.status = res ? res.status() : 0;
  info.errors = errors.filter(e => !/Failed to load resource/.test(e.text));
  info.fails = [...failedOn.entries()].map(([u, f]) => ({ url: u, ...f }));
  info.cookies = (await ctx.cookies()).map(c => c.name + ' (' + c.domain + ')');
  info.trackersOnLoad = [...trackedOn];
  pageInfo.push(info);
  pageText.push({ page: p, text: info.fullText });
  for (const l of info.links) linkRecords.push({ ...l, page: p, ids: info.ids, pageUrl: url });
  process.stderr.write('.');
}

// ---- links
const origin = new URL(t.start).origin;
const nowhere = [], generic = [], anchors = [], placeholders = [], fakeButtons = [];
const toCheck = new Map(); // url -> [records]
for (const l of linkRecords) {
  if (l.hidden) continue; // hidden, inert or decorative (a mockup of an app): not a link anyone uses
  const raw = (l.raw ?? '').trim();
  const empty = l.raw == null || raw === '' || raw === '#' || /^javascript:\s*(void\(0\);?|;)?\s*$/i.test(raw);
  if (empty && /^(back to top|top|to top|do góry|na górę|w górę|arriba|nach oben)$/i.test(l.text)) continue;
  if (empty && l.button) { fakeButtons.push(l); continue; }
  if (l.raw == null) { nowhere.push({ ...l, why: 'has no address' }); continue; }
  if (raw === '' ) { nowhere.push({ ...l, why: 'has an empty address' }); continue; }
  if (empty) { nowhere.push({ ...l, why: `only points to “${raw}”` }); continue; }
  if (/^(mailto|tel):\s*$/i.test(raw)) { nowhere.push({ ...l, why: `${raw} has no address` }); continue; }
  if (/^(mailto|tel|sms|javascript):/i.test(raw)) continue;
  if (PLACEHOLDER.test(raw)) { placeholders.push({ ...l, why: raw }); continue; }
  let u; try { u = new URL(l.href); } catch { nowhere.push({ ...l, why: `“${raw}” isn't a valid address` }); continue; }
  if (raw.startsWith('#')) { const id = decodeURIComponent(raw.slice(1)); if (id && !l.ids.includes(id) && id !== 'top') anchors.push({ ...l, why: `nothing on the page has id “${id}”` }); continue; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (SOCIAL[host] && SOCIAL[host](u.pathname)) { generic.push({ ...l, host }); continue; }
  const key = u.origin + u.pathname + u.search;
  if (!toCheck.has(key)) toCheck.set(key, []);
  toCheck.get(key).push(l);
}
const linkLine = l => `“${esc(l.text || (l.icon ? 'icon' : 'link'))}” → ${esc(l.raw || '')} · ${esc(l.page)}`;
if (nowhere.length) issue({ priority: 'high', who: 'you', area: 'Links', title: `${plural(nowhere.length, 'link')} that ${nowhere.length === 1 ? 'goes' : 'go'} nowhere`,
  detail: [...new Set(nowhere.map(l => l.why))].join(', ') + '.', ask: 'Where should each one go?', places: nowhere.map(l => `${linkLine(l)} (${esc(l.why)})`),
  items: nowhere.map(l => ({ text: l.text, href: l.raw, page: l.page, selector: l.path })) });
if (placeholders.length) issue({ priority: 'high', who: 'you', area: 'Links', title: `${plural(placeholders.length, 'link')} still pointing at a placeholder`,
  detail: 'Addresses like example.com or localhost.', ask: 'What are the real addresses?', places: placeholders.map(linkLine), items: placeholders.map(l => ({ text: l.text, href: l.raw, page: l.page, selector: l.path })) });
if (generic.length) {
  const hosts = [...new Set(generic.map(l => l.host))];
  const NAMES = { 'github.com': 'GitHub', 'x.com': 'X', 'twitter.com': 'Twitter', 'youtube.com': 'YouTube', 'linkedin.com': 'LinkedIn', 'tiktok.com': 'TikTok', 'facebook.com': 'Facebook', 'instagram.com': 'Instagram', 'bsky.app': 'Bluesky', 't.me': 'Telegram', 'producthunt.com': 'Product Hunt' };
  const nameOf = h => NAMES[h] || h.replace(/\.(com|net|app|gg)$/, '').replace(/^./, c => c.toUpperCase());
  issue({ priority: 'high', who: 'you', area: 'Links', title: `${hosts.map(nameOf).join(', ').replace(/, ([^,]*)$/, ' and $1')} ${generic.length === 1 ? 'link goes' : 'links go'} to the homepage, not your profile`,
    detail: [...new Set(generic.map(l => l.raw))].join(', '), ask: 'Send the profile links.', places: generic.map(linkLine), items: generic.map(l => ({ text: l.text, href: l.raw, page: l.page, selector: l.path })) });
}
if (fakeButtons.length) issue({ priority: 'low', who: 'me', area: 'Links', title: `${plural(fakeButtons.length, 'link')} used as ${fakeButtons.length === 1 ? 'a button' : 'buttons'}`,
  detail: 'They run a script instead of going somewhere. A real <button> works with the keyboard and screen readers.', places: fakeButtons.map(l => linkLine(l)), items: fakeButtons.map(l => ({ text: l.text, href: l.raw, page: l.page, selector: l.path })) });
if (anchors.length) issue({ priority: 'medium', who: 'me', area: 'Links', title: `${plural(anchors.length, 'link')} to a spot on the page that doesn't exist`,
  detail: 'The link jumps to an id that no element has.', places: anchors.map(l => `${linkLine(l)} (${esc(l.why)})`), items: anchors.map(l => ({ text: l.text, href: l.raw, page: l.page, selector: l.path })) });

// check the targets: internal always, external unless --no-external
async function status(u) {
  const tryOnce = async method => {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
    try { const r = await fetch(u, { method, redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Accept: 'text/html,*/*' } }); return r.status; }
    catch (e) { return e.name === 'AbortError' ? -1 : 0; } finally { clearTimeout(tm); }
  };
  let s = await tryOnce('HEAD');
  if (s === 405 || s === 403 || s === 404 || s === 0 || s === 501) s = await tryOnce('GET');
  return s;
}
const internal = [...toCheck.keys()].filter(u => u.startsWith(origin));
const external = opts['no-external'] ? [] : [...toCheck.keys()].filter(u => !u.startsWith(origin));
const results = new Map();
const queue = [...internal, ...external];
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) { const u = queue.shift(); results.set(u, await status(u)); } }));
const broken = [], unsure = [];
for (const [u, s] of results) {
  const recs = toCheck.get(u);
  const isInternal = u.startsWith(origin);
  if (s >= 400 && ![401, 403, 429, 999].includes(s)) (isInternal || s === 404 || s === 410 ? broken : unsure).push({ u, s, recs, isInternal });
  else if (s <= 0 && !isInternal) unsure.push({ u, s, recs, isInternal });
}
if (broken.length) issue({ priority: 'high', who: 'you', area: 'Links', title: `${plural(broken.length, 'link')} to a page that doesn't exist`,
  detail: broken.map(b => `${b.isInternal ? pathOf(b.u) : b.u} (${b.s})`).join(', '), ask: 'Should these pages exist, or should the links go somewhere else?',
  places: broken.flatMap(b => b.recs.map(l => `${linkLine(l)} · ${b.s}`)), items: broken.flatMap(b => b.recs.map(l => ({ text: l.text, href: l.raw, page: l.page, selector: l.path, status: b.s }))) });
if (unsure.length) issue({ priority: 'low', who: 'you', area: 'Links', title: `${plural(unsure.length, 'outside link')} I couldn't open`,
  detail: 'They may block automated checks. Open them once by hand.', places: unsure.flatMap(b => b.recs.map(l => `${linkLine(l)} · ${b.s > 0 ? b.s : b.s === -1 ? 'timed out' : 'no answer'}`)),
  items: unsure.flatMap(b => b.recs.map(l => ({ text: l.text, href: l.raw, page: l.page, status: b.s }))) });
if (!nowhere.length && !generic.length && !broken.length && !placeholders.length) passed.push(`All ${plural(linkRecords.length, 'link')} lead somewhere`);

// ---- 404 page
{
  const probe = origin + '/this-page-does-not-exist-' + Math.random().toString(36).slice(2, 8);
  const p404 = await ctx.newPage();
  let st = 0; try { const r = await p404.goto(probe, { waitUntil: 'networkidle', timeout: 20000 }); st = r ? r.status() : 0; } catch {}
  const look = await p404.evaluate(home => ({
    sheets: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href), styleTags: document.querySelectorAll('style').length,
    links: document.querySelectorAll('a[href]').length, els: document.body ? document.body.querySelectorAll('*').length : 0, text: (document.body ? document.body.innerText : '').trim().slice(0, 200),
  })).catch(() => ({ sheets: [], styleTags: 0, links: 0, els: 0, text: '' }));
  const homeSheets = new Set(pageInfo[0] ? pageInfo[0].sheets : []);
  const designed = (look.sheets.some(s => homeSheets.has(s)) || look.styleTags > 0) && look.links >= 2 && look.els > 15;
  const pic = await p404.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }).catch(() => null);
  await p404.close();
  if (st === 200) issue({ priority: 'medium', who: 'me', area: 'Error page', title: 'Missing pages answer “200 OK”', detail: `${pathOf(probe)} loads a normal page instead of a 404. Search engines can index pages that don't exist.`, shot: shot(pic && pic.toString('base64')), places: [] });
  else if (!designed) issue({ priority: 'medium', who: 'me', area: 'Error page', title: 'No designed 404 page', detail: look.links >= 1 ? 'A missing page shows a plain template, not in the site’s style.' : `A missing page shows ${look.text ? '“' + look.text.slice(0, 60) + '”' : 'a blank page'}, with no way back to the site.`, places: [] });
  else passed.push('Designed 404 page');
}

// ---- images
{
  const noAlt = [], badAlt = [], brokenImg = [], heavy = [], linkNoAlt = [];
  const seen = new Set();
  for (const pi of pageInfo) for (const im of pi.imgs) {
    const key = im.src + '|' + pi.page;
    if (seen.has(key)) continue; seen.add(key);
    const name = (im.raw || im.src || '').split('/').pop().split('?')[0];
    if (im.complete && im.nw === 0 && im.raw) brokenImg.push({ ...im, page: pi.page, name });
    if (!im.hasAlt && !im.decorativeRole) noAlt.push({ ...im, page: pi.page, name });
    else if (im.hasAlt && im.alt.trim() === '' && im.inLink) linkNoAlt.push({ ...im, page: pi.page, name });
    else if (im.hasAlt && (/^(image|img|photo|picture|foto|zdjęcie|obraz|grafika|logo|icon|banner|untitled|alt)$/i.test(im.alt.trim()) || /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(im.alt.trim()) || /^(IMG|DSC|DCIM|Screenshot|Screen Shot|PXL|Untitled)[\s_-]?\d*/i.test(im.alt.trim())))
      badAlt.push({ ...im, page: pi.page, name });
    if (im.nw && im.w && !im.hidden && im.nw > im.w * 3 && im.nw > 1600) heavy.push({ ...im, page: pi.page, name, why: `${im.nw}px wide, shown at ${Math.round(im.w)}px` });
    else if (im.bytes > 600000) heavy.push({ ...im, page: pi.page, name, why: `${Math.round(im.bytes / 1024)} KB` });
  }
  const imgLine = i => `${esc(i.name)} · ${esc(i.page)}`;
  if (brokenImg.length) issue({ priority: 'high', who: 'me', area: 'Images', title: `${plural(brokenImg.length, 'image')} that ${brokenImg.length === 1 ? "doesn't" : "don't"} load`, detail: 'The file is missing or the path is wrong.', places: brokenImg.map(imgLine), items: brokenImg.map(i => ({ src: i.raw, page: i.page, selector: i.path })) });
  if (noAlt.length) issue({ priority: 'high', who: 'me', area: 'Images', title: `${plural(noAlt.length, 'image')} without alt text`, detail: 'Screen readers read out the file name instead. I can write the alt text from the images, you check it.', places: noAlt.map(imgLine), items: noAlt.map(i => ({ src: i.raw, page: i.page, selector: i.path })) });
  if (linkNoAlt.length) issue({ priority: 'high', who: 'me', area: 'Images', title: `${plural(linkNoAlt.length, 'linked image')} with empty alt text`, detail: "The image is the link's only content, so the link has no name.", places: linkNoAlt.map(imgLine), items: linkNoAlt.map(i => ({ src: i.raw, page: i.page, selector: i.path })) });
  if (badAlt.length) issue({ priority: 'medium', who: 'me', area: 'Images', title: `${plural(badAlt.length, 'image')} with alt text that says nothing`, detail: [...new Set(badAlt.map(i => `“${i.alt}”`))].join(', '), places: badAlt.map(i => `${imgLine(i)} · alt “${esc(i.alt)}”`), items: badAlt.map(i => ({ src: i.raw, alt: i.alt, page: i.page, selector: i.path })) });
  if (heavy.length) issue({ priority: 'low', who: 'me', area: 'Images', title: `${plural(heavy.length, 'image')} much bigger than needed`, detail: 'They slow the page down.', places: heavy.map(i => `${imgLine(i)} · ${esc(i.why)}`), items: heavy.map(i => ({ src: i.raw, page: i.page, why: i.why })) });
  if (!noAlt.length && !badAlt.length && !brokenImg.length && !linkNoAlt.length) passed.push('Alt text on every image');
}

// ---- favicon
{
  const icons = new Map();
  for (const pi of pageInfo) for (const ic of pi.icons) icons.set(ic.href, ((icons.get(ic.href) || '') + ' ' + ic.rel).trim());
  const iconList = [...icons.entries()];
  const ok = [], bad = [];
  for (const [href, rel] of iconList) { const s = await status(href); (s >= 200 && s < 400 ? ok : bad).push({ href, rel, s }); }
  const fallback = await status(origin + '/favicon.ico');
  const hasIcon = ok.some(i => /icon/.test(i.rel) && !/apple/.test(i.rel)) || (fallback >= 200 && fallback < 400);
  if (bad.length) issue({ priority: 'high', who: 'you', area: 'Favicon', title: `Favicon file${bad.length > 1 ? 's' : ''} missing`, detail: `The page asks for ${bad.map(b => pathOf(b.href)).join(', ')}, which ${bad.length > 1 ? "don't" : "doesn't"} exist.`, ask: 'Which image should be the icon? I can make it from your logo.', places: bad.map(b => `${esc(pathOf(b.href))} · ${b.s}`) });
  else if (!hasIcon) issue({ priority: 'high', who: 'you', area: 'Favicon', title: 'No favicon', detail: 'Browser tabs and bookmarks show a blank icon.', ask: 'Which image should be the icon? I can make it from your logo.', places: [] });
  else passed.push('Favicon');
  if (hasIcon && !ok.some(i => /apple/.test(i.rel))) issue({ priority: 'low', who: 'me', area: 'Favicon', title: 'No icon for phone home screens', detail: 'Add a 180×180 icon so a shortcut saved on an iPhone shows your logo.', places: [] });
}

// ---- legal pages and cookies
function dropFromBroken(hrefs) {
  const i = issues.findIndex(x => x.area === 'Links' && /doesn't exist/.test(x.title));
  if (i < 0) return;
  const left = broken.filter(b => !hrefs.includes(b.u));
  if (!left.length) { issues.splice(i, 1); return; }
  issues[i] = { ...issues[i], title: `${plural(left.length, 'link')} to a page that doesn't exist`, detail: left.map(b => `${b.isInternal ? pathOf(b.u) : b.u} (${b.s})`).join(', '),
    places: left.flatMap(b => b.recs.map(l => `${linkLine(l)} · ${b.s}`)), items: left.flatMap(b => b.recs.map(l => ({ text: l.text, href: l.raw, page: l.page, selector: l.path, status: b.s }))) };
}
{
  const find = re => linkRecords.filter(l => re.test(l.text) || re.test(l.raw || ''));
  const privacy = find(/privacy|prywatno|datenschutz|confidentialit|privacidad|rodo|gdpr/i);
  const terms = find(/terms|regulamin|conditions|warunki|\btos\b|agb|nutzungsbedingungen|condiciones/i);
  for (const [name, list, prio] of [['privacy policy', privacy, 'high'], ['terms of use', terms, 'medium']]) {
    const Name = name[0].toUpperCase() + name.slice(1);
    if (!list.length) { issue({ priority: prio, who: 'you', area: 'Legal pages', title: `No ${name}`, detail: `No page links to a ${name}.`, ask: `Do you have a ${name}? I can draft one for a lawyer to check.`, places: [] }); continue; }
    const hrefs = [...new Set(list.map(l => { try { const u = new URL(l.href); return u.origin + u.pathname; } catch { return ''; } }).filter(Boolean))];
    const dead = hrefs.filter(h => { const s = results.get(h); return s != null && s >= 400; });
    const empty = list.filter(l => !l.raw || l.raw === '#');
    if (dead.length) dropFromBroken(dead);
    if (dead.length || (empty.length === list.length)) issue({ priority: 'high', who: 'you', area: 'Legal pages', title: `${Name} link leads nowhere`, detail: dead.length ? `${dead.map(pathOf).join(', ')} doesn't exist.` : 'The link has no address.', ask: `Do you have the ${name} text? I can draft one for a lawyer to check.`, places: list.map(linkLine) });
    else passed.push(Name);
  }
  const found = new Map();
  for (const pi of pageInfo) {
    for (const src of pi.scripts.concat(pi.inline.match(/https?:\/\/[^\s'"]+/g) || [])) for (const [re, name] of TRACKERS) if (re.test(src)) { if (!found.has(name)) found.set(name, new Set()); found.get(name).add(pi.page); }
  }
  const banner = pageInfo.some(pi => pi.banner || pi.cmp);
  const cookies = [...new Set(pageInfo.flatMap(pi => pi.cookies))];
  const early = new Map();
  for (const pi of pageInfo) for (const n of pi.trackersOnLoad || []) { if (!early.has(n)) early.set(n, new Set()); early.get(n).add(pi.page); }
  if (banner && early.size) issue({ priority: 'high', who: 'you', area: 'Cookies', title: 'Tracking starts before people agree',
    detail: `${[...early.keys()].join(', ')} ${early.size === 1 ? 'loads' : 'load'} as soon as the page opens, while the cookie banner is still waiting for an answer${cookies.length ? ', and cookies are set' : ''}.`,
    ask: 'Should tracking wait for consent? I can make the scripts load only after people agree.', places: [...early.entries()].map(([n, ps]) => `${esc(n)} · ${esc([...ps].join(', '))}`).concat(cookies.map(c => 'cookie ' + esc(c))) });
  else if (found.size && !banner) issue({ priority: 'high', who: 'you', area: 'Cookies', title: 'Tracking without a cookie banner',
    detail: `The site loads ${[...found.keys()].join(', ')}${cookies.length ? ' and sets cookies' : ''}, but never asks for consent. In the EU that needs a banner first.`,
    ask: 'Add a consent banner (I can build a simple one), or drop the tracking?', places: [...found.entries()].map(([n, ps]) => `${esc(n)} · ${esc([...ps].join(', '))}`).concat(cookies.map(c => 'cookie ' + esc(c))) });
  else if (found.size) passed.push('Cookie banner, and tracking waits for it');
  else passed.push('No tracking, so no cookie banner needed');
}

// ---- titles, descriptions, share images, language, headings
{
  const titles = new Map();
  for (const pi of pageInfo) { const k = (pi.title || '').trim(); if (!titles.has(k)) titles.set(k, []); titles.get(k).push(pi.page); }
  const noTitle = pageInfo.filter(pi => !(pi.title || '').trim());
  const dupTitles = [...titles.entries()].filter(([k, ps]) => k && ps.length > 1);
  if (noTitle.length) issue({ priority: 'high', who: 'me', area: 'Search and sharing', title: `${plural(noTitle.length, 'page')} without a title`, detail: 'The tab and search results show the address instead.', places: noTitle.map(p => esc(p.page)) });
  if (dupTitles.length) issue({ priority: 'medium', who: 'me', area: 'Search and sharing', title: `${plural(dupTitles.reduce((n, [, ps]) => n + ps.length, 0), 'page')} sharing the same title`, detail: dupTitles.map(([k, ps]) => `“${k}” on ${ps.join(', ')}`).join('; '), places: dupTitles.flatMap(([k, ps]) => ps.map(p => `${esc(p)} · “${esc(k)}”`)) });
  const noDesc = pageInfo.filter(pi => !(pi.description || '').trim());
  if (noDesc.length) issue({ priority: 'medium', who: 'me', area: 'Search and sharing', title: `${plural(noDesc.length, 'page')} without a description`, detail: 'Search results and link previews make one up from the page.', places: noDesc.map(p => esc(p.page)) });
  const noImg = pageInfo.filter(pi => !pi.ogImage);
  const withImg = pageInfo.filter(pi => pi.ogImage);
  if (noImg.length) issue({ priority: noImg.length === pageInfo.length ? 'high' : 'medium', who: withImg.length ? 'me' : 'you', area: 'Search and sharing',
    title: `${plural(noImg.length, 'page')} without a share image`, detail: 'A link to the page on social media or in a chat shows no picture.',
    ask: withImg.length ? null : 'Which image should show when the site is shared? I can make one from the home page.', places: noImg.map(p => esc(p.page)) });
  // check share images load and have a sensible size
  const ogs = new Map(); for (const pi of withImg) { const u = new URL(pi.ogImage, pi.url).href; if (!ogs.has(u)) ogs.set(u, []); ogs.get(u).push(pi.page); }
  const ogPage = await ctx.newPage();
  for (const [u, ps] of ogs) {
    const dims = await ogPage.goto(u, { timeout: 15000 }).then(async r => {
      if (!r || r.status() >= 400) return { status: r ? r.status() : 0 };
      return ogPage.evaluate(() => { const i = document.querySelector('img'); return i ? { w: i.naturalWidth, h: i.naturalHeight, status: 200 } : { status: 200 }; });
    }).catch(() => ({ status: 0 }));
    const elsewhere = new URL(u).origin !== origin;
    if (dims.status >= 400 || dims.status === 0) issue({ priority: 'high', who: 'me', area: 'Search and sharing', title: "Share image doesn't load", detail: `${elsewhere ? u : pathOf(u)} answers ${dims.status || 'nothing'}${elsewhere ? ' on the live site' : ''}.`, places: ps.map(esc) });
    else if (dims.w && (dims.w < 600 || Math.abs(dims.w / dims.h - 1.91) > 0.35)) issue({ priority: 'low', who: 'me', area: 'Search and sharing', title: 'Share image has an odd size', detail: `${pathOf(u)} is ${dims.w}×${dims.h}. 1200×630 shows best everywhere.`, places: ps.map(esc) });
  }
  await ogPage.close();
  const noCard = pageInfo.filter(pi => pi.ogImage && !pi.twitterCard);
  if (noCard.length) issue({ priority: 'low', who: 'me', area: 'Search and sharing', title: `${plural(noCard.length, 'page')} with a small preview on X`, detail: 'Add the twitter:card tag, and X shows the share image large.', places: noCard.map(p => esc(p.page)) });
  const noLang = pageInfo.filter(pi => !pi.lang);
  if (noLang.length) issue({ priority: 'medium', who: 'me', area: 'Search and sharing', title: `${plural(noLang.length, 'page')} without a language set`, detail: 'Screen readers may read it in the wrong accent, and translation offers misfire.', places: noLang.map(p => esc(p.page)) });
  const h1s = pageInfo.filter(pi => pi.h1 !== 1);
  if (h1s.length) issue({ priority: 'low', who: 'me', area: 'Search and sharing', title: `${plural(h1s.length, 'page')} without exactly one main heading`, detail: h1s.map(p => `${p.page}: ${p.h1 ? p.h1 + ' main headings' : 'no main heading'}`).join(', '), places: h1s.map(p => esc(p.page)) });
  if (!noTitle.length && !noDesc.length && !noImg.length) passed.push('Titles, descriptions and share images');
}

// ---- script errors and missing files
{
  const errs = pageInfo.filter(pi => pi.errors.length);
  if (errs.length) issue({ priority: 'high', who: 'me', area: 'Errors', title: `Script errors on ${plural(errs.length, 'page')}`, detail: 'Something on the page may not work.', places: errs.flatMap(pi => pi.errors.map(e => `${esc(pi.page)} · ${esc(e.text.slice(0, 160))}`)) });
  const files = new Map();
  for (const pi of pageInfo) for (const f of pi.fails) {
    if (/favicon|apple-touch-icon/.test(f.url)) continue;
    const ext = !f.url.startsWith(origin);
    if (ext && f.status === 0) continue; // trackers and fonts blocked offline are not the site's fault
    if (!files.has(f.url)) files.set(f.url, { ...f, pages: new Set() });
    files.get(f.url).pages.add(pi.page);
  }
  if (files.size) issue({ priority: 'high', who: 'me', area: 'Errors', title: `${plural(files.size, 'file')} the pages ask for but can't get`, detail: [...new Set([...files.values()].map(f => f.type))].join(', '),
    places: [...files.entries()].map(([u, f]) => `${esc(u.startsWith(origin) ? pathOf(u) : u)} · ${f.status || f.error} · ${esc([...f.pages].join(', '))}`) });
  if (!errs.length && !files.size) passed.push('No script errors or missing files');
}
await ctx.close();

// ------------------------------------------------------------------ breakpoints
function layoutProblems() {
  const A = window.__audit;
  const W = document.documentElement.clientWidth;
  const out = { overflow: [], cut: [], stretched: [], navLinks: 0, menuButton: false, scrollW: document.documentElement.scrollWidth, W };
  const clipsX = el => { for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) { const s = getComputedStyle(n); if (/hidden|clip|auto|scroll/.test(s.overflowX)) return n; } return null; };
  // things sticking out past the right edge
  if (out.scrollW > W + 1) {
    const culprits = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.right <= W + 1) continue;
      if (A.hidden(el)) continue;
      let fixedUp = false; for (let n = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') { fixedUp = true; break; }
      if (fixedUp) continue; // an off-screen drawer
      const box = clipsX(el); if (box && box !== document.body) continue;
      if (culprits.some(c => c.contains(el))) continue;
      for (let i = culprits.length - 1; i >= 0; i--) if (el.contains(culprits[i])) culprits.splice(i, 1);
      culprits.push(el);
    }
    // the innermost ones that still stick out are the cause
    const causes = culprits.map(c => {
      let el = c;
      for (;;) { const kid = [...el.children].find(k => k.getBoundingClientRect().right > W + 1 && !A.hidden(k)); if (!kid || kid.getBoundingClientRect().width < el.getBoundingClientRect().width * 0.98) break; el = kid; }
      return el;
    });
    A.els = A.els || [];
    for (const el of causes.slice(0, 5)) {
      const r = el.getBoundingClientRect();
      out.overflow.push({ idx: A.els.push(el) - 1, what: A.sig(el), selector: A.path(el), width: Math.round(r.width), right: Math.round(r.right), minWidth: getComputedStyle(el).minWidth, text: (el.innerText || '').trim().slice(0, 40) });
    }
  }
  // text cut off by its own box or a box around it
  A.els = A.els || [];
  const seen = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (!A.ownText(el).length || A.hidden(el)) continue;
    const s = getComputedStyle(el);
    const tr = A.textRect(el);
    if (tr.width < 2) continue;
    let cutBy = null;
    if (/hidden|clip/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== 'ellipsis') cutBy = el;
    // vertically: a whole extra line hidden, not just letters with tails poking out of a tight line height
    const lineH = A.px(s.lineHeight) || A.px(s.fontSize) * 1.2;
    if (!cutBy && /hidden|clip/.test(s.overflowY) && el.scrollHeight > el.clientHeight + lineH * 0.5 && !s.webkitLineClamp.match(/\d/) && s.textOverflow !== 'ellipsis') cutBy = el;
    if (!cutBy) for (let n = el.parentElement, k = 0; n && k < 6 && n !== document.body; n = n.parentElement, k++) {
      const ns = getComputedStyle(n);
      if (!/hidden|clip/.test(ns.overflowX + ns.overflowY)) continue;
      const b = n.getBoundingClientRect();
      if (tr.x + tr.width > b.right + 2 || tr.x < b.left - 2 || (tr.y + tr.height > b.bottom + lineH * 0.5 && /hidden|clip/.test(ns.overflowY))) {
        // only text that partly shows is cut; text entirely outside is closed (an accordion, a menu)
        const vis = Math.min(tr.x + tr.width, b.right) - Math.max(tr.x, b.left);
        const visH = Math.min(tr.y + tr.height, b.bottom) - Math.max(tr.y, b.top);
        if (vis > 2 && visH > 2) cutBy = n;
        break;
      }
    }
    if (!cutBy || seen.has(cutBy)) continue;
    // a box that scrolls sideways (a carousel, a table) shows the rest when scrolled
    if (cutBy !== el && /auto|scroll/.test(getComputedStyle(cutBy).overflowX)) continue;
    // carousels and marquees scroll on purpose: many children in a row, or an animation
    if (cutBy !== el && (cutBy.children.length > 3 && getComputedStyle(cutBy).display.includes('flex')) || /marquee|carousel|slider|swiper|ticker/i.test(cutBy.className + ' ' + el.className)) continue;
    if (getComputedStyle(el).animationName !== 'none') continue;
    seen.add(cutBy);
    const full = A.ownText(el).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const short = full.length > 60 ? full.slice(0, 60).replace(/\s+\S*$/, '') + '…' : full;
    out.cut.push({ idx: A.els.push(el) - 1, what: A.sig(el), selector: A.path(el), text: short, by: cutBy === el ? 'its own box' : A.sig(cutBy) });
    if (out.cut.length >= 8) break;
  }
  // stretched images
  for (const img of document.querySelectorAll('img')) {
    if (A.hidden(img) || !img.naturalWidth) continue;
    const r = img.getBoundingClientRect(); if (r.width < 24 || r.height < 24) continue; // tiny raster icons; avatars squeezed to 48×36 still count
    const s = getComputedStyle(img);
    if (s.objectFit !== 'fill') continue;
    const a = img.naturalWidth / img.naturalHeight, b = r.width / r.height;
    if (Math.abs(a - b) / a > 0.06 && !/\.svg/i.test(img.currentSrc)) out.stretched.push({ idx: A.els.push(img) - 1, what: A.sig(img), selector: A.path(img), src: (img.getAttribute('src') || '').split('/').pop(), natural: `${img.naturalWidth}×${img.naturalHeight}`, shown: `${Math.round(r.width)}×${Math.round(r.height)}` });
  }
  // navigation that can be reached
  // a real navigation only: a <header> can just be a hero section with buttons
  const nav = document.querySelector('header nav, nav, [role="navigation"]');
  if (nav) {
    const shown = [...nav.querySelectorAll('a')].filter(a => !A.hidden(a) && a.getBoundingClientRect().width > 0);
    out.navLinks = shown.length;
    out.navHrefs = shown.map(a => a.getAttribute('href') || '');
    out.menuButton = [...document.querySelectorAll('header [aria-expanded], nav [aria-expanded], header [aria-controls], nav [aria-controls], button[class*="menu" i], button[class*="burger" i], button[class*="hamburger" i], button[class*="toggle" i], [class*="menu-button" i], [class*="nav-toggle" i], .w-nav-button, header button, nav button')]
      .some(b => !A.hidden(b) && b.getBoundingClientRect().width > 0 && (b.matches('[aria-expanded],[aria-controls],[class*="menu" i],[class*="burger" i],[class*="toggle" i],.w-nav-button') || !A.text(b).trim() || /menu|menü|nawigac/i.test(A.text(b) + ' ' + (b.getAttribute('aria-label') || ''))));
  }
  return out;
}

const WIDTHS = [375, 768, 1024, 1440];
const layout = new Map(); // key -> issue builder
const navAt = new Map();
for (const w of WIDTHS) {
  const c = await browser.newContext({ viewport: { width: w, height: 900 } });
  const pg = await c.newPage();
  for (const url of urls) {
    await settle(pg, url);
    await pg.evaluate(INSTALL);
    const r = await pg.evaluate(layoutProblems);
    const p = pathOf(url);
    navAt.set(`${p}|${w}`, r);
    const picture = async (idx, color) => {
      const rect = await pg.evaluate(([i, color]) => {
        const el = window.__audit.els[i]; const bb = el.getBoundingClientRect(); scrollTo(scrollX, Math.max(0, bb.top + scrollY - innerHeight / 2));
        el.style.setProperty('outline', '3px solid ' + color, 'important'); el.style.setProperty('outline-offset', '-1px', 'important');
        const r = el.getBoundingClientRect();
        return { cy: r.top + r.height / 2, vw: innerWidth, vh: innerHeight };
      }, [idx, color]);
      await pg.waitForTimeout(80);
      // a band of the screen around it, as wide as the screen
      const h = Math.min(rect.vh, Math.max(360, Math.round(rect.vw * 0.6)));
      const y = Math.max(0, Math.min(rect.vh - h, Math.round(rect.cy - h / 2)));
      const png = await pg.screenshot({ animations: 'disabled', clip: { x: 0, y, width: rect.vw, height: h } }).catch(() => null);
      await pg.evaluate(i => { const el = window.__audit.els[i]; el.style.removeProperty('outline'); el.style.removeProperty('outline-offset'); }, idx);
      await pg.evaluate(() => scrollTo(0, 0));
      return png ? png.toString('base64') : null;
    };
    for (const o of r.overflow) {
      const k = `overflow|${o.what}`;
      if (!layout.has(k)) layout.set(k, { type: 'overflow', what: o.what, selector: o.selector, text: o.text, widths: [], pages: new Set(), shot: null, detail: `${o.width}px wide${o.minWidth !== 'auto' && o.minWidth !== '0px' ? ', min-width ' + o.minWidth : ''}` });
      const L = layout.get(k); if (!L.widths.includes(w)) L.widths.push(w); L.pages.add(p);
      if (!L.shot) L.shot = await picture(o.idx, '#FF383C');
    }
    for (const o of r.cut) {
      const k = `cut|${o.what}|${o.text}`;
      if (!layout.has(k)) layout.set(k, { type: 'cut', what: o.what, selector: o.selector, text: o.text, by: o.by, widths: [], pages: new Set(), shot: null });
      const L = layout.get(k); if (!L.widths.includes(w)) L.widths.push(w); L.pages.add(p);
      if (!L.shot) L.shot = await picture(o.idx, '#FF383C');
    }
    for (const o of r.stretched) {
      const k = `stretch|${o.src}`;
      if (!layout.has(k)) layout.set(k, { type: 'stretched', what: o.what, selector: o.selector, src: o.src, natural: o.natural, shown: o.shown, widths: [], pages: new Set(), shot: null });
      const L = layout.get(k); if (!L.widths.includes(w)) L.widths.push(w); L.pages.add(p);
      if (!L.shot) L.shot = await picture(o.idx, '#FF383C');
    }
    process.stderr.write('.');
  }
  await c.close();
}
// nav that disappears without a menu button
const navGone = [];
for (const url of urls) {
  const p = pathOf(url);
  const desk = navAt.get(`${p}|1440`);
  for (const w of [375, 768]) {
    const r = navAt.get(`${p}|${w}`);
    if (desk && r && desk.navLinks >= 3 && r.navLinks < desk.navLinks && !r.menuButton) {
      const gone = (desk.navHrefs || []).filter(h => !(r.navHrefs || []).includes(h));
      navGone.push({ page: p, w, desktop: desk.navLinks, now: r.navLinks, anchorsOnly: gone.length > 0 && gone.every(h => h.startsWith('#')) });
    }
  }
}
let navShot = null;
if (navGone.length) {
  const c = await browser.newContext({ viewport: { width: navGone[0].w, height: 700 } });
  const pg = await c.newPage(); await settle(pg, new URL(navGone[0].page, t.start).href);
  navShot = (await pg.screenshot({ clip: { x: 0, y: 0, width: navGone[0].w, height: Math.round(navGone[0].w * 0.6) } }).catch(() => null))?.toString('base64') || null;
  await c.close();
}
await browser.close();
t.close();

const wlist = ws => ws.sort((a, b) => a - b).map(w => w + 'px').join(', ');
// "main > section.partners > ul.partners__logos" -> "The partners logos"
const TAGWORD = { ul: 'list', ol: 'list', li: 'list item', img: 'image', p: 'paragraph', a: 'link', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', nav: 'navigation', table: 'table', pre: 'code block', div: 'box', section: 'section', header: 'header', footer: 'footer', span: 'text', button: 'button', form: 'form', input: 'field', figure: 'figure', video: 'video', iframe: 'embed' };
const UTILITY = /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|container|overflow|truncate|group|peer|w-|h-|min-|max-|[mp][trblxyse]?-\d|text-|font-|bg-|border|rounded|shadow|gap-|space-|items-|justify-|z-|top-|left-|right-|bottom-|inset|opacity|transition|duration|ease|col-|row-|leading-|tracking-|whitespace|object-|aspect-|cursor|select-|sr-only|w-(layout|inline|container|clearfix|richtext|embed|nav|dropdown)|color-scheme|is-|has-|js-|u-|c-|l-)|:|^[a-z]{1,2}\d|\d{2,}/i;
function friendly(sig) {
  const last = String(sig).split(' > ').pop();
  const [tag, ...cls] = last.split('#')[0].split('.');
  const c = cls.find(x => x && x.length > 2 && !UTILITY.test(x));
  const words = c ? c.replace(/\d+/g, '').replace(/__|--|[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim() : (TAGWORD[tag] || tag);
  return 'The ' + words;
}
for (const L of layout.values()) {
  const pages = [...L.pages];
  if (L.type === 'overflow') issue({ priority: 'high', who: 'me', area: 'Layout', title: `Page scrolls sideways at ${wlist(L.widths)}`, detail: `${friendly(L.what)} sticks out (${L.detail}).`, shot: shot(L.shot), places: pages.map(esc), items: [{ selector: L.selector, widths: L.widths, pages }] });
  if (L.type === 'cut') issue({ priority: 'high', who: 'me', area: 'Layout', title: `Text cut off at ${wlist(L.widths)}`, detail: `“${L.text}” doesn't fit ${L.by === 'its own box' ? 'its box' : 'in ' + friendly(L.by).replace(/^The /, 'the ')}.`, shot: shot(L.shot), places: pages.map(esc), items: [{ selector: L.selector, text: L.text, widths: L.widths, pages }] });
  if (L.type === 'stretched') issue({ priority: 'medium', who: 'me', area: 'Layout', title: `Stretched image at ${wlist(L.widths)}`, detail: `${L.src} is ${L.natural} but shown at ${L.shown}.`, shot: shot(L.shot), places: pages.map(esc), items: [{ selector: L.selector, src: L.src, widths: L.widths, pages }] });
}
if (navGone.length) issue({ priority: navGone.every(n => n.anchorsOnly) ? 'medium' : 'high', who: 'me', area: 'Layout', title: `Navigation disappears at ${wlist([...new Set(navGone.map(n => n.w))])}`,
  detail: `${navGone[0].desktop} links on desktop, ${navGone[0].now} on a ${navGone[0].w}px screen, and no menu button to reach the rest.${navGone.every(n => n.anchorsOnly) ? ' They only jump to sections of the same page, so it may be on purpose.' : ''}`, shot: shot(navShot),
  places: navGone.map(n => `${esc(n.page)} · ${n.w}px`), items: navGone });
if (![...layout.values()].length && !navGone.length) passed.push('Nothing breaks at 375, 768, 1024 and 1440');

// ------------------------------------------------------------------ spelling: obvious repeats here, the rest Claude reads
const typos = [];
for (const pt of pageText) for (const m of pt.text.matchAll(/(?<![\p{L}])([\p{L}]+)[ \u00a0]+\1(?![\p{L}])/giu)) {
  if (/^(ha|bye|no|yes|tak|nie|very|bardzo)$/i.test(m[1])) continue;
  const i = m.index; typos.push({ page: pt.page, wrong: m[0], right: m[1], context: pt.text.slice(Math.max(0, i - 30), i + m[0].length + 30).replace(/\s+/g, ' ') });
}
fs.writeFileSync(textFile, pageText.map(pt => `## ${pt.page}\n\n${pt.text.replace(/\n{3,}/g, '\n\n').trim()}\n`).join('\n'));

const data = { site: t.local || t.start, name: t.name, date: new Date().toISOString(), pages: urls.map(pathOf), issues: [], passed, textFile, typosChecked: false };
const order = { high: 0, medium: 1, low: 2 };
issues.sort((a, b) => order[a.priority] - order[b.priority]);
data.issues = issues.map((x, i) => ({ id: 'w' + (i + 1), ...x }));
if (typos.length) addTypos(data, typos, true);
fs.writeFileSync(out.json, JSON.stringify(data, null, 2));
fs.writeFileSync(shotsFile, JSON.stringify(shots));
render(data, shots);
summary(data);

// ------------------------------------------------------------------ shared by both runs
function addTypos(data, list, partial) {
  data.issues = data.issues.filter(i => i.area !== 'Spelling');
  if (!partial) data.typosChecked = true;
  if (!list.length) { if (!partial && !data.passed.includes('No typos found')) data.passed.push('No typos found'); return; }
  data.issues.push({ id: 'w' + (data.issues.length + 1), priority: 'medium', who: 'me', area: 'Spelling', title: `${plural(list.length, 'typo')}`,
    detail: list.slice(0, 6).map(x => `${x.wrong} → ${x.right}`).join(', '), places: list.map(x => `${esc(x.wrong)} → ${esc(x.right)} · ${esc(x.page)} · “${esc(x.context || '')}”`), items: list });
  const order = { high: 0, medium: 1, low: 2 };
  data.issues.sort((a, b) => order[a.priority] - order[b.priority]);
  data.issues.forEach((x, i) => { x.id = 'w' + (i + 1); });
}

function render(data, shots) {
  const row = i => `<div class="item${i.shot && shots[i.shot] ? '' : ' no-lead'}">${i.shot && shots[i.shot] ? `<img class="thumb" src="data:image/png;base64,${shots[i.shot]}" alt="">` : ''}<div>
    <p class="what">${esc(i.title)}</p><p class="why">${esc(i.detail)}</p>${i.ask ? `<p class="why">Needs from you: ${esc(i.ask)}</p>` : ''}${where(i.places || [])}</div></div>`;
  const pr = p => data.issues.filter(i => i.priority === p);
  const sec = (name, list) => list.length ? `<h2>${name} <span class="n">${list.length}</span></h2><div class="list">${list.map(row).join('')}</div>` : '';
  const me = data.issues.filter(i => i.who === 'me').length, you = data.issues.filter(i => i.who === 'you').length;
  let body = `<div class="stats">
    <div class="stat"><div class="n">${pr('high').length}</div><div class="k">to fix first</div></div>
    <div class="stat"><div class="n">${me}</div><div class="k">I can fix on my own</div></div>
    <div class="stat"><div class="n">${you}</div><div class="k">need your input</div></div>
  </div>`;
  body += sec('Fix first', pr('high')) + sec('Fix next', pr('medium')) + sec('Worth a look', pr('low'));
  if (!data.issues.length) body += '<h2>Nothing to fix</h2>';
  if (data.passed.length) body += `<h2>Fine <span class="n">${data.passed.length}</span></h2><div class="list">${data.passed.map(p => `<div class="item no-lead"><p>${esc(p)}</p></div>`).join('')}</div>`;
  body += `<p class="foot sm">${plural(data.pages.length, 'page')} checked at 375, 768, 1024 and 1440 px.${data.typosChecked ? '' : ' Spelling: only repeated words so far.'}</p><p class="sm">Pages: ${data.pages.map(esc).join(', ')}</p>`;
  const site = data.name || (String(data.site).startsWith('http') ? new URL(data.site).host : String(data.site).split('/').pop());
  fs.writeFileSync(out.html, reportPage({ title: 'Website audit', sub: `${esc(site)} · ${plural(data.pages.length, 'page')} · ${date()}`, body }));
}
function summary(data) {
  console.log(JSON.stringify({ report: out.html, data: out.json, pageText: textFile,
    issues: { high: data.issues.filter(i => i.priority === 'high').length, medium: data.issues.filter(i => i.priority === 'medium').length, low: data.issues.filter(i => i.priority === 'low').length },
    canFix: data.issues.filter(i => i.who === 'me').map(i => i.title), needsInput: data.issues.filter(i => i.who === 'you').map(i => i.title), passed: data.passed }, null, 2));
}
