// Copied from shared/lib by tools/sync-shared.sh. Edit it there.
// The browser (the Chrome already on the computer, through playwright-core), a small static server,
// and finding a site's pages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function launch() {
  let pw;
  try { pw = await import('playwright-core'); }
  catch {
    try { pw = await import('playwright'); }
    catch {
      console.error(`playwright-core isn't installed. Run once:\n  npm install --prefix "${SCRIPTS}"`);
      process.exit(2);
    }
  }
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  const tries = [{ channel: 'chrome' }, { channel: 'msedge' }, {}];
  let last;
  for (const opts of tries) {
    try { return await chromium.launch({ headless: true, ...opts }); } catch (e) { last = e; }
  }
  console.error("Couldn't start a browser. Install Google Chrome, or run: npx playwright install chromium\n" + (last && last.message));
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

// Serves a folder the way static hosts do: /about finds about.html or about/index.html, and a missing
// page gets the site's own 404.html (with status 404) when it has one.
export function serveFolder(root) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const candidates = [file, file + '.html', path.join(file, 'index.html')];
    const hit = candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!hit) {
      const nf = path.join(root, '404.html');
      if (fs.existsSync(nf)) { res.writeHead(404, { 'Content-Type': TYPES['.html'] }); return res.end(fs.readFileSync(nf)); }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(hit).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(hit).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
  }));
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) out[k] = argv[++i]; else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// The site to check: a URL, or a folder served for the run.
export async function target(opts) {
  if (opts.root) {
    const s = await serveFolder(opts.root);
    const local = path.resolve(opts.root);
    return { base: s.url, start: s.url + '/', close: s.close, local, name: path.basename(path.dirname(local)) + '/' + path.basename(local) };
  }
  const url = opts.url || opts._[0];
  if (!url) { console.error('Give a site: --url http://localhost:3000 or --root ./site'); process.exit(1); }
  const u = new URL(url);
  return { base: u.origin, start: u.href, close: () => {}, local: null, name: u.host };
}

const SKIP_EXT = /\.(pdf|png|jpe?g|gif|webp|avif|svg|ico|zip|mp4|webm|mov|mp3|wav|css|js|json|xml|txt|woff2?|ttf|otf)$/i;

// Same-site pages linked from the start page, then from those, up to `max`.
export async function findPages(browser, start, { max = 20, only, root } = {}) {
  if (only) return only.split(',').map(p => new URL(p.trim(), start).href);
  const origin = new URL(start).origin;
  const seen = new Set([norm(start)]);
  const queue = [start];
  const pages = [];
  const page = await browser.newPage();
  while (queue.length && pages.length < max) {
    const url = queue.shift();
    let res;
    try { res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch { continue; }
    if (!res || res.status() >= 400) continue;
    const ct = (res.headers()['content-type'] || '');
    if (!ct.includes('html')) continue;
    if (new URL(page.url()).origin !== origin) continue; // redirected to another site
    if (pages.some(p => norm(p) === norm(page.url()))) continue;
    pages.push(page.url());
    const links = await page.$$eval('a[href]', as => as.map(a => a.href));
    for (const l of links) {
      let u; try { u = new URL(l); } catch { continue; }
      if (u.origin !== origin || SKIP_EXT.test(u.pathname)) continue;
      const n = norm(u.href);
      if (seen.has(n)) continue;
      seen.add(n); queue.push(u.origin + u.pathname);
    }
  }
  await page.close();
  // a folder: also every page nothing links to
  if (root) {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      if (e.name.startsWith('.') || e.name === 'node_modules') return [];
      const f = path.join(d, e.name);
      return e.isDirectory() ? walk(f) : /\.html?$/i.test(e.name) && e.name !== '404.html' ? [f] : [];
    });
    for (const f of walk(root).sort()) {
      if (pages.length >= max) break;
      const rel = path.relative(root, f).split(path.sep).join('/');
      const u = new URL('/' + rel.replace(/(^|\/)index\.html?$/i, '$1'), start).href;
      if (!pages.some(p => norm(p) === norm(u))) pages.push(u);
    }
  }
  return pages;
}
function norm(u) { const x = new URL(u); return x.origin + x.pathname.replace(/\/index\.html?$/, '/').replace(/\.html?$/, '').replace(/\/$/, '') ; }

// Load a page and let it settle: scroll through so lazy images and scroll-in sections show.
export async function settle(page, url, { timeout = 30000 } = {}) {
  const errors = [];
  const onConsole = m => { if (m.type() === 'error') errors.push({ text: m.text(), url: (m.location() || {}).url || '' }); };
  const onError = e => errors.push({ text: String(e && e.message || e), url: '' });
  page.on('console', onConsole); page.on('pageerror', onError);
  let res = null;
  // load, then a short wait for the network to go quiet (chat widgets and polling never do)
  try { res = await page.goto(url, { waitUntil: 'load', timeout }); }
  catch { try { res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); } catch {} }
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  // smooth scrolling would leave every scroll below half done when the script looks
  await page.addStyleTag({ content: '*,html,body{scroll-behavior:auto!important}' }).catch(() => {});
  await page.evaluate(async () => {
    const H = () => document.documentElement.scrollHeight;
    for (let y = 0; y < H() && y < 40000; y += Math.round(innerHeight * 0.8)) { scrollTo(0, y); await new Promise(r => setTimeout(r, 90)); }
    scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));
  }).catch(() => {});
  await page.waitForTimeout(400);
  page.off('console', onConsole); page.off('pageerror', onError);
  return { res, errors };
}

export function outDir(opts, name) {
  const dir = path.resolve(opts.out || 'site-reports');
  fs.mkdirSync(dir, { recursive: true });
  return { dir, html: path.join(dir, name + '.html'), json: path.join(dir, name + '.json') };
}

export const pathOf = u => { try { const x = new URL(u); return x.pathname + (x.search || ''); } catch { return u; } };
