function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function parseColor(str) {
  if (typeof str !== "string") return null;
  const s = str.trim();

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
