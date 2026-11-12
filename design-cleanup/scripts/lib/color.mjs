// Copied from shared/lib by tools/sync-shared.sh. Edit it there.
// Colors: parsing, WCAG contrast, OKLab distance, and finding a passing shade.

export function parse(str) {
  if (!str) return null;
  if (Array.isArray(str)) return str;
  str = String(str).trim();
  let m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    const n = [0, 2, 4, 6].map(i => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  m = str.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const v = p.map((x, i) => (x.endsWith('%') ? (i < 3 ? parseFloat(x) * 2.55 : parseFloat(x) / 100) : parseFloat(x)));
    return [v[0], v[1], v[2], v[3] == null ? 1 : v[3]];
  }
  if (str === 'transparent') return [0, 0, 0, 0];
  return null;
}

export const hex = c => '#' + c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

// put a see-through color over an opaque one
export function over(top, bottom) {
  const a = top[3] == null ? 1 : top[3];
  return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1);
}

const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
export const luminance = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export const ratio = r => (Math.floor(r * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + ':1';

// OKLab, for "how different do these look"
export function oklab(c) {
  const [r, g, b] = c.slice(0, 3).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const unlin = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
export function fromOklab([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return rgb.map(v => Math.round(Math.max(0, Math.min(255, unlin(v))))).concat(1);
}
// distance in OKLab x100: under ~2 is hard to tell apart, under ~5 looks like the same color
export function distance(a, b) {
  const x = oklab(a), y = oklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
}

// The closest shade of `fg` (same hue and chroma, only lighter or darker) that reaches `target` on `bg`.
export function nearestPassing(fg, bg, target) {
  const [L, A, B] = oklab(fg);
  const best = [];
  for (const dir of [1, -1]) {
    for (let step = 0; step <= 100; step++) {
      const nl = L + dir * step * 0.01;
      if (nl < 0 || nl > 1) break;
      // keep chroma within gamut by fading it at the extremes
      const k = Math.min(1, Math.min(nl, 1 - nl) * 4);
      const c = fromOklab([nl, A * k, B * k]);
      if (contrast(c, bg) >= target + 0.02) { best.push({ c, step }); break; }
    }
  }
  if (!best.length) {
    // no shade of this color gets there: black or white, but only if that passes
    const bw = luminance(bg) > 0.18 ? [0, 0, 0, 1] : [255, 255, 255, 1];
    return contrast(bw, bg) >= target ? bw : null;
  }
  best.sort((a, b) => a.step - b.step);
  // prefer the direction away from the background
  return best[0].c;
}
