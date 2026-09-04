function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function srgbGamma(x) {
  x = clamp(x, 0, 1);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function to255(n) {
  return clamp(Math.round(n), 0, 255);
}

function numFrom(str) {
  const m = /^([-+]?\d*\.?\d+)(%)?$/.exec(String(str).trim());
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  if (m[2]) v /= 100;
  return v;
}

/** OKLab (L 0..1, a, b) -> sRGB bytes. Bjorn Ottosson's exact matrices. */
export function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { r: to255(srgbGamma(r) * 255), g: to255(srgbGamma(g) * 255), b: to255(srgbGamma(bb) * 255), a: 1 };
}

/** OKLCH (L 0..1, C, H deg) -> sRGB bytes. */
export function oklchToRgb(L, C, H) {
  const hr = (H * Math.PI) / 180;
  return oklabToRgb(L, C * Math.cos(hr), C * Math.sin(hr));
}

/** CIE Lab (L 0..100, a, b) -> sRGB bytes (D65). */
export function labToRgb(L, a, b) {
  const y = (L + 16) / 116;
  const x = a / 500 + y;
  const z = y - b / 200;
  const finv = (t) => (Math.pow(t, 3) > 0.008856 ? Math.pow(t, 3) : (t - 16 / 116) / 7.787);
  const X = 0.95047 * finv(x);
  const Y = 1.0 * finv(y);
  const Z = 1.08883 * finv(z);
  const r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  const g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  const bb = X * 0.0557 - Y * 0.204 + Z * 1.057;
  return { r: to255(srgbGamma(r) * 255), g: to255(srgbGamma(g) * 255), b: to255(srgbGamma(bb) * 255), a: 1 };
}

export function parseColor(str) {
  if (typeof str !== "string") return null;
  const s = str.trim();

  const space = /^((?:oklch|oklab|lab|lch))\s*\(([^)]*)\)$/i.exec(s);
  if (space) {
    const kind = space[1].toLowerCase();
    const parts = space[2].split(/[\s,/]+/).filter(Boolean).map((p) => numFrom(p));
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (kind === "oklch") return oklchToRgb(parts[0], parts[1] || 0, parts[2] || 0);
    if (kind === "oklab") return oklabToRgb(parts[0], parts[1] || 0, parts[2] || 0);
    if (kind === "lab") return labToRgb(parts[0], parts[1] || 0, parts[2] || 0);
    if (kind === "lch") {
      const hr = ((parts[2] || 0) * Math.PI) / 180;
      return labToRgb(parts[0], (parts[1] || 0) * Math.cos(hr), (parts[1] || 0) * Math.sin(hr));
    }
    return null;
  }

  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length === 4) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].every((v) => !Number.isNaN(v))) {
        return { r, g, b, a: clamp(a, 0, 1) };
      }
    }
    return null;
  }

  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const conv = (p) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
      const r = conv(parts[0]);
      const g = conv(parts[1]);
      const b = conv(parts[2]);
      let a = 1;
      if (parts[3] !== undefined) {
        a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      }
      if ([r, g, b, a].every((v) => !Number.isNaN(v))) {
        return { r, g, b, a: clamp(a, 0, 1) };
      }
    }
    return null;
  }
  return null;
}

export function formatColor({ r, g, b, a }) {
  const toHex = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  if (a >= 1) return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  const round = (n) => Math.round(n * 1000) / 1000;
  return `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${round(a)})`;
}

function mixChannel(a, b, t) {
  return a * (1 - t) + b * t;
}

export function mix(c1, c2, weight = 0.5) {
  const t = clamp(weight, 0, 1);
  return {
    r: mixChannel(c1.r, c2.r, t),
    g: mixChannel(c1.g, c2.g, t),
    b: mixChannel(c1.b, c2.b, t),
    a: mixChannel(c1.a, c2.a, t),
  };
}

export function withAlpha(c, a) {
  return { ...c, a: clamp(a, 0, 1) };
}

export function lighten(c, amount) {
  return mix(c, { r: 255, g: 255, b: 255, a: c.a }, clamp(amount, 0, 1));
}

export function darken(c, amount) {
  return mix(c, { r: 0, g: 0, b: 0, a: c.a }, clamp(amount, 0, 1));
}

/** sRGB bytes ({r,g,b} 0..255) -> OKLCH {L (0..1), C (0..~0.4), H (0..360)}. */
export function rgbToOklch({ r, g, b, a }) {
  const lin = (c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const lr = lin(r), lg = lin(g), lb = lin(b);
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const lc = Math.cbrt(l_), mc = Math.cbrt(m_), sc = Math.cbrt(s_);
  const L = 0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc;
  const A = 1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc;
  const B = 0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H, a: a == null ? 1 : a };
}

/**
 * Weighted distance between two OKLCH colors. 0 means identical. Lightness and
 * chroma dominate; hue is normalized to 0..1 so a 180deg hue flip costs at most
 * ~1 unit. A `maxDistance` of ~0.1 captures near-identical colors (the
 * "nearly match" case for hardcoded-value adoption linting).
 */
export function oklchDistance(a, b) {
  const dL = a.L - b.L;
  const dC = (a.C || 0) - (b.C || 0);
  let dH = Math.abs((a.H || 0) - (b.H || 0));
  if (dH > 180) dH = 360 - dH;
  const wL = 1, wC = 2.5, wH = 1;
  return Math.sqrt(wL * dL * dL + wC * dC * dC + wH * (dH / 180) * (dH / 180));
}
