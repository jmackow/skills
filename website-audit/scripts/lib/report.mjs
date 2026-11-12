// Copied from shared/lib by tools/sync-shared.sh. Edit it there.
// The report page: one self-contained HTML file, black and white, light and dark.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root {
  color-scheme: light;
  --bg: #FFFFFF; --bg2: #F7F7F7; --fg: #191A1C; --fg2: rgba(0,0,0,.5); --fg3: rgba(0,0,0,.26);
  --fill: rgba(0,0,0,.06); --border: rgba(0,0,0,.10); --danger: #E5262A;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0E0E0F; --bg2: #171718; --fg: #E9E9E9; --fg2: rgba(255,255,255,.45); --fg3: rgba(255,255,255,.25);
    --fill: rgba(255,255,255,.06); --border: rgba(255,255,255,.08); --danger: #FF4245;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif;
  font-size: 15px; line-height: 20px; letter-spacing: -0.3px; -webkit-font-smoothing: antialiased; }
.page { max-width: 860px; margin: 0 auto; padding: 56px 24px 96px; }
h1 { margin: 0; font-size: 26px; line-height: 32px; letter-spacing: -0.78px; font-weight: 500; }
h2 { margin: 48px 0 12px; font-size: 17px; line-height: 22px; letter-spacing: -0.51px; font-weight: 500; }
h2 .n { color: var(--fg2); font-weight: 400; }
p { margin: 0; }
a { color: inherit; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; letter-spacing: 0; }
.sm, .sub, .why, .where, .k { font-size: 13px; line-height: 16px; letter-spacing: -0.26px; color: var(--fg2); }
.sub { margin-top: 8px; }
.lead { margin-top: 12px; color: var(--fg2); max-width: 600px; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-top: 32px; }
.stat { padding: 20px; border-radius: 12px; background: var(--bg2); }
.stat .n { font-size: 38px; line-height: 44px; letter-spacing: -1px; font-weight: 500; font-variant-numeric: tabular-nums; }
.stat .k { margin-top: 4px; }

.list { border-radius: 12px; box-shadow: 0 0 0 1px var(--border); overflow: hidden; }
.item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; padding: 16px; align-items: start; }
.item.no-lead { grid-template-columns: minmax(0, 1fr); }
.item + .item { border-top: 1px solid var(--border); }
.item .what { font-weight: 500; }
.item .why { margin-top: 4px; }
.item .fix { margin-top: 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.item .where { margin-top: 8px; }
details summary { cursor: pointer; color: var(--fg2); font-size: 13px; line-height: 16px; letter-spacing: -0.26px; list-style: none; }
details summary::-webkit-details-marker { display: none; }
details summary::before { content: "›"; display: inline-block; width: 12px; transition: transform 120ms ease; }
details[open] summary::before { transform: rotate(90deg); }
details ul { margin: 8px 0 0; padding: 0 0 0 12px; list-style: none; display: grid; gap: 4px; color: var(--fg2); font-size: 13px; line-height: 16px; }

.sample { display: grid; place-items: center; width: 56px; height: 40px; border-radius: 8px; font-size: 17px; font-weight: 500; letter-spacing: -0.3px; box-shadow: inset 0 0 0 1px var(--border); flex: none; }
.sw { display: inline-block; width: 14px; height: 14px; border-radius: 4px; vertical-align: -2px; box-shadow: inset 0 0 0 1px var(--fg3); }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 16px; letter-spacing: -0.26px; }
.shot { display: block; max-width: 100%; border-radius: 8px; box-shadow: 0 0 0 1px var(--border); background: var(--bg2); }
.thumb { width: 120px; height: 72px; object-fit: cover; object-position: center; border-radius: 6px; box-shadow: 0 0 0 1px var(--border); background: var(--bg2); cursor: zoom-in; }
.variant .pic img { cursor: zoom-in; }
dialog.zoom { max-width: min(1200px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 0; border: 0; border-radius: 12px; background: var(--bg); box-shadow: 0 0 0 1px var(--border), 0 8px 24px rgba(0,0,0,.2); overflow: auto; }
dialog.zoom::backdrop { background: rgba(0,0,0,.5); }
dialog.zoom img { display: block; max-width: 100%; cursor: zoom-out; }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.variants { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-top: 12px; }
.variant { display: grid; gap: 8px; align-content: start; }
.variant .pic { display: grid; place-items: center; min-height: 72px; padding: 12px; border-radius: 8px; background: var(--bg2); box-shadow: 0 0 0 1px var(--border); overflow: hidden; }
.variant .pic img { max-width: 100%; max-height: 120px; }
.variant .sm b { color: var(--fg); font-weight: 500; }
.diff { color: var(--fg); font-weight: 500; }
.bad { color: var(--danger); }
table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 16px; letter-spacing: -0.26px; }
th { text-align: left; font-weight: 400; color: var(--fg2); padding: 0 12px 8px 0; }
td { padding: 8px 12px 8px 0; border-top: 1px solid var(--border); vertical-align: top; }
.empty { padding: 16px; color: var(--fg2); }
.foot { margin-top: 48px; }
@media (max-width: 560px) {
  .page { padding: 32px 16px 64px; }
  .item { grid-template-columns: minmax(0, 1fr); }
}
`;

export function page({ title, sub, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main class="page">
<h1>${esc(title)}</h1>
${sub ? `<p class="sub">${sub}</p>` : ''}
${body}
</main>
<dialog class="zoom"><img alt=""></dialog>
<script>
const d = document.querySelector('dialog.zoom');
document.addEventListener('click', e => {
  const img = e.target.closest('.thumb, .variant .pic img');
  if (img) { d.firstElementChild.src = img.src; d.showModal(); return; }
  if (e.target.closest('dialog.zoom')) d.close();
});
</script></body></html>`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

export function where(places, max = 30) {
  if (!places || !places.length) return '';
  const list = places.slice(0, max).map(p => `<li>${p}</li>`).join('') + (places.length > max ? `<li>and ${places.length - max} more</li>` : '');
  return `<details class="where"><summary>${plural(places.length, 'place')}</summary><ul>${list}</ul></details>`;
}

export const date = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
