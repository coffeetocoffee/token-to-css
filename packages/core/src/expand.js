/**
 * `$expand` — compact token generators that materialize into full token sets
 * at compile time, before reference resolution. Expanded tokens are
 * indistinguishable from hand-written ones downstream: they participate in
 * `{refs}`, `calc()`, themes, and every output format.
 *
 * Four generators, one `$expand` block per group:
 *
 *   ramp   — `{ "$value": "#3b82f6", "$expand": { "ramp": { "steps": [50, 100, 500, 900] } } }`
 *            Perceptually even OKLCH ramp seeded by `$value`: lightness spans
 *            `lightness` (default [0.95, 0.25]) evenly across the steps; hue
 *            and chroma come from the seed (chroma capped at 0.37 to stay in
 *            gamut). `$value` is consumed as the seed, not emitted.
 *
 *   scale  — `{ "$expand": { "scale": { "base": 0.25, "ratio": 1.25,
 *              "steps": ["xs","sm","md","lg","xl"], "unit": "rem" } } }`
 *            step i = base * ratio^i, unit appended.
 *
 *   fluid  — `{ "$expand": { "fluid": { "min": "1rem", "max": "2rem",
 *              "steps": ["sm","md","lg"], "vwMin": 320, "vwMax": 1200 } } }`
 *            Interpolated `clamp()` tokens between min (at vwMin) and max
 *            (at vwMax). Both lengths must share one unit.
 *
 *   cross  — `{ "$expand": { "cross": { "size": ["sm","md"], "variant": ["primary","ghost"] },
 *              "template": { "bg": "{color.{variant}}", "pad": "{spacing.{size}}" } } }`
 *            Cartesian product of the cross arrays; `{placeholder}` in the
 *            template is substituted with the combo value (unknown
 *            placeholders — i.e. token refs — pass through untouched).
 *            Combo keys join with `join` (default "-").
 *
 * `expandTokens` returns `{ tokens, generated }`; `generated` carries one
 * provenance entry per materialized token for inspectability.
 */
import { parseColor, formatColor, rgbToOklch, oklchToRgb } from "./color.js";

function fmt(n) {
  const r = Math.round(n * 10000) / 10000;
  return String(r);
}

function stepNames(steps, at) {
  if (Array.isArray(steps)) {
    if (!steps.length) throw new Error(at);
    return steps.map(String);
  }
  const n = typeof steps === "number" ? Math.floor(steps) : NaN;
  if (!(n >= 1)) throw new Error(at);
  return Array.from({ length: n }, (_, i) => String(i));
}

function expandRamp(group, spec, at) {
  const seed = group.$value ?? spec.base;
  const parsed = parseColor(seed == null ? null : String(seed));
  if (!parsed) {
    throw new Error(`$expand ramp at "${at}": seed "${seed}" is not a parseable color`);
  }
  const { C: baseC, H: baseH } = rgbToOklch(parsed);
  const names = stepNames(spec.steps, `$expand ramp at "${at}": steps must be a non-empty array or count`);
  const [lo, hi] = spec.lightness || [0.95, 0.25];
  const n = names.length;
  const out = {};
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const L = lo + (hi - lo) * t;
    const C = Math.min((spec.chroma ?? 1) * baseC, 0.37);
    out[names[i]] = formatColor(oklchToRgb(L, C, baseH));
  }
  return out;
}

function expandScale(spec, at) {
  const { base, ratio = 2, steps, unit = "rem" } = spec;
  if (typeof base !== "number" || !Number.isFinite(base)) {
    throw new Error(`$expand scale at "${at}": "base" must be a number`);
  }
  const names = stepNames(steps, `$expand scale at "${at}": steps must be a non-empty array or count`);
  const out = {};
  for (let i = 0; i < names.length; i++) {
    out[names[i]] = fmt(base * Math.pow(ratio, i)) + (unit === "none" ? "" : unit);
  }
  return out;
}

function parseLen(s, at) {
  const m = /^(-?\d*\.?\d+)(rem|px|em|ch|ex|%)$/.exec(String(s).trim());
  if (!m) {
    throw new Error(`$expand fluid at "${at}": "${s}" is not a length with unit (rem|px|em|ch|ex|%)`);
  }
  return { v: parseFloat(m[1]), u: m[2] };
}

function expandFluid(spec, at) {
  const { min, max, steps, vwMin = 320, vwMax = 1200 } = spec;
  const a = parseLen(min, at);
  const b = parseLen(max, at);
  if (a.u !== b.u) {
    throw new Error(`$expand fluid at "${at}": min/max units differ (${a.u} vs ${b.u})`);
  }
  if (!(vwMax > vwMin)) {
    throw new Error(`$expand fluid at "${at}": vwMax must be greater than vwMin`);
  }
  const names = stepNames(steps, `$expand fluid at "${at}": steps must be a non-empty array or count`);
  const slope = (b.v - a.v) / (vwMax - vwMin);
  const intercept = a.v - slope * vwMin;
  const n = names.length;
  const out = {};
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const mid = a.v + (b.v - a.v) * t;
    out[names[i]] =
      `clamp(${fmt(a.v)}${a.u}, ${fmt(intercept)}${a.u} + ${fmt(slope * 100)}vw, ` +
      `${fmt(n === 1 ? a.v : mid < Math.min(a.v, b.v) ? Math.min(a.v, b.v) : Math.min(mid, Math.max(a.v, b.v)))}${a.u})`;
  }
  return out;
}

function substitute(node, combo, at) {
  if (typeof node === "string") {
    // First replace {placeholder} tokens where placeholder matches one of the cross keys.
    let out = node;
    for (const k of Object.keys(combo)) {
      out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(combo[k]));
    }
    return out;
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, combo, at);
    return out;
  }
  return node;
}

function expandCross(spec, at) {
  const { cross, template, join = "-" } = spec;
  const keys = cross && typeof cross === "object" ? Object.keys(cross) : [];
  if (!keys.length) {
    throw new Error(`$expand cross at "${at}": "cross" must map dimension names to non-empty arrays`);
  }
  for (const k of keys) {
    if (!Array.isArray(cross[k]) || !cross[k].length) {
      throw new Error(`$expand cross at "${at}": dimension "${k}" must be a non-empty array`);
    }
  }
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new Error(`$expand cross at "${at}": "template" must be an object`);
  }
  const out = {};
  function combos(i, acc) {
    if (i === keys.length) {
      const name = keys.map((k) => String(acc[k])).join(join);
      // First do placeholders, then any remaining string refs.
      const substituted = substitute(structuredClone(template), acc, at);
      out[name] = substituted;
      return;
    }
    for (const v of cross[keys[i]]) combos(i + 1, { ...acc, [keys[i]]: v });
  }
  combos(0, {});
  return out;
}

const GENERATORS = ["ramp", "scale", "fluid", "cross"];

export function expandTokens(input) {
  const generated = [];
  let changed = false;

  function walk(node, path) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    if ("$expand" in node) {
      changed = true;
      const spec = node.$expand;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error(`$expand at "${path.join(".") || "(root)"}" must be an object`);
      }
      const kind = GENERATORS.find((g) => g in spec);
      const at = path.join(".") || "(root)";
      if (!kind) {
        throw new Error(
          `$expand at "${at}" must contain exactly one generator key: ${GENERATORS.join(", ")}`
        );
      }
      let gen;
      if (kind === "ramp") gen = expandRamp(node, spec.ramp, at);
      else if (kind === "scale") gen = expandScale(spec.scale, at);
      else if (kind === "fluid") gen = expandFluid(spec.fluid, at);
      else gen = expandCross(spec, at);

      // Explicit sibling keys survive and override generated ones.
      const out = { ...gen };
      for (const [k, v] of Object.entries(node)) {
        if (k === "$expand" || k === "$value" || k === "$type") continue;
        out[k] = walk(v, [...path, k]);
      }
      for (const name of Object.keys(gen)) {
        generated.push({ path: [...path, name].join("."), kind });
      }
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, [...path, k]);
    return out;
  }

  const tokens = walk(input, []);
  return { tokens: changed ? tokens : input, generated };
}
