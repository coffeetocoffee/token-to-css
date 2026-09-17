import { deepMerge } from "./merge.js";
import { BAREFOOT_MAP } from "./presets/barefoot.js";
import { TAILWIND_MAP } from "./presets/tailwind.js";
import { setByPath } from "./registry.js";

// Reverse of BAREFOOT_MAP: barefoot var name (without --) -> token path.
const BAREFOOT_REVERSE = (() => {
  const m = {};
  for (const [token, varName] of Object.entries(BAREFOOT_MAP)) {
    m[varName.replace(/^--/, "")] = token;
  }
  return m;
})();

// v14: reverse of TAILWIND_MAP — Tailwind v4 CSS-first `@theme` var name
// (without `--`, e.g. `color-foreground`) -> flat token name (e.g.
// `color-text`). Identity entries (e.g. `color-primary`) are harmless.
const TAILWIND_REVERSE = (() => {
  const m = {};
  for (const [flatName, varName] of Object.entries(TAILWIND_MAP)) {
    m[String(varName).replace(/^--/, "")] = flatName;
  }
  return m;
})();

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Brace-aware block splitter. Returns [{ selector, body }] for each top-level
// block. Brace-less input (raw SCSS `$vars;` lines) is returned as a single
// selector-less block so it can be parsed as base declarations.
function extractBlocks(css) {
  const blocks = [];
  let i = 0;
  let buf = "";
  let depth = 0;
  let selector = null;
  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (c === "{") {
      if (depth === 0) {
        selector = buf.trim();
        buf = "";
      } else {
        buf += c;
      }
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) {
        blocks.push({ selector, body: buf.trim() });
        buf = "";
        selector = null;
      } else {
        buf += c;
      }
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (depth === 0 && buf.trim().length && blocks.length === 0) {
    blocks.push({ selector: null, body: buf.trim() });
  }
  return blocks;
}

// v11.0: `:` is accepted inside names so federated registry canonicals
// (`org:team:canonical`) survive the round-trip. Keep verbatim otherwise.
const DECL_RE = /(--[\w:-]+|\$[\w-]+)\s*:\s*([^;]+);/g;

function parseBody(body) {
  const out = [];
  let m;
  DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(body))) {
    let name = m[1];
    const value = m[2].trim();
    if (name.startsWith("$")) name = name.slice(1);
    else name = name.replace(/^--/, "");
    if (name.startsWith("bf-") && BAREFOOT_REVERSE[name]) {
      name = BAREFOOT_REVERSE[name];
    }
    out.push([name, value]);
  }
  return out;
}

function unflatten(entries) {
  const root = {};
  for (const [flatName, value] of entries) {
    const parts = flatName.split("-");
    let node = root;
    let skip = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (node[p] == null) node[p] = {};
      else if (typeof node[p] !== "object") {
        // Collision: this path is already a leaf (e.g. `--color-primary`
        // vs `--color-primary-hover`). Kebab-case is ambiguous, so we keep
        // the exact leaf and cannot also nest — best-effort behavior.
        skip = true;
        break;
      }
      node = node[p];
    }
    if (!skip) node[parts[parts.length - 1]] = value;
  }
  return root;
}

function selectorTarget(selector) {
  const modeM = /data-mode="([^"]+)"/.exec(selector);
  const brandM = /data-brand="([^"]+)"/.exec(selector);
  return {
    mode: modeM ? modeM[1] : null,
    brand: brandM ? brandM[1] : null,
  };
}

/** Fold parsed declarations into `target`, losslessly when a registry is given. */
function applyInto(target, decls, registry, opts = {}) {
  const tailwind = Boolean(opts.tailwind);
  // Map every declaration name first, then fold through ONE unflatten() call so
  // the best-effort kebab-collision guard applies (the exact leaf is kept;
  // the colliding nested branch is dropped — never clobbered via deepMerge).
  const mapped = decls.map(([name, value]) => [
    tailwind && TAILWIND_REVERSE[name] ? TAILWIND_REVERSE[name] : name,
    value,
  ]);
  if (registry) {
    const rest = [];
    for (const [name, value] of mapped) {
      const path = registry.pathOf(name);
      if (path) {
        setByPath(target, path, value);
      } else {
        rest.push([name, value]);
      }
    }
    if (rest.length) deepMerge(target, unflatten(rest));
    return;
  }
  deepMerge(target, unflatten(mapped));
}

/**
 * Best-effort parser: CSS/SCSS custom properties -> a nested token tree
 * (the inverse of `convert` with `format: "css"` / `"scss"`).
 *
 * - `:root { --x: ... }` becomes the base tree.
 * - `[data-mode="dark"] { ... }` is folded into `modes.dark`.
 * - `[data-brand="acme"] { ... }` is folded into `brands.acme`.
 * - `[data-mode="dark"][data-brand="acme"]` is folded into both.
 * - barefoot `--bf-*` vars are mapped back to token paths.
 * - v14: Tailwind v4 CSS-first `@theme { --x: ... }` blocks are folded into
 *   the base tree, and Tailwind-mapped var names (e.g. `--color-foreground`
 *   for the `color.text` token) are mapped back via `TAILWIND_MAP` — so
 *   `reverse(convert(tokens, { format: "tailwind" }))` round-trips token
 *   values. Pass `{ tailwind: true }` to force the mapping, or rely on
 *   auto-detection when any top-level `@theme` block is present.
 *
 * When `options.registry` (a registry built with `buildNameRegistry` /
 * `registryFromJSON`) is provided, every canonical name is mapped straight back
 * to its original token path, so `reverse(convert(tokens, { registry }))`
 * reproduces `tokens` byte-for-byte even for kebab-colliding token names.
 *
 * Values are kept verbatim (already resolved in generated output).
 */
export function reverse(css, options = {}) {
  const cleaned = stripComments(css);
  const blocks = extractBlocks(cleaned);
  const base = {};
  const modes = {};
  const brands = {};
  const registry = options.registry || null;
  // v14: auto-detect a Tailwind v4 CSS-first theme when any top-level block
  // is an `@theme` block (covers `@theme` and `@theme inline`).
  const tailwind =
    options.tailwind === true ||
    (options.tailwind !== false &&
      blocks.some(
        ({ selector }) =>
          selector != null && /^\s*@theme(?:\s|$)/.test(selector)
      ));
  const intoOpts = { tailwind };
  for (const { selector, body } of blocks) {
    const sel = selector == null ? null : selector.replace(/^@theme/, "").trim();
    const decls = parseBody(body);
    if (!decls.length) continue;
    const { mode, brand } = selectorTarget(sel || "");
    if (mode && brand) {
      modes[mode] = modes[mode] || {};
      applyInto(modes[mode], decls, registry, intoOpts);
      brands[brand] = brands[brand] || {};
      applyInto(brands[brand], decls, registry, intoOpts);
    } else if (mode) {
      modes[mode] = modes[mode] || {};
      applyInto(modes[mode], decls, registry, intoOpts);
    } else if (brand) {
      brands[brand] = brands[brand] || {};
      applyInto(brands[brand], decls, registry, intoOpts);
    } else {
      applyInto(base, decls, registry, intoOpts);
    }
  }
  const result = { ...base };
  if (Object.keys(modes).length) result.modes = modes;
  if (Object.keys(brands).length) result.brands = brands;
  return result;
}

/**
 * v14: inverse of the Tailwind v4 CSS-first `@theme` output format.
 * `reverseTailwind(convert(tokens, { format: "tailwind" }))` reproduces the
 * token values (keyed by token path). Accepts the same `options` as
 * `reverse` (notably `{ registry }` for lossless kebab-collision handling).
 */
export function reverseTailwind(css, options = {}) {
  return reverse(css, { ...options, tailwind: true });
}

/**
 * Inverse of the `style-dictionary` output format: `{ value: ... }` leaves are
 * unwrapped back to plain token values.
 */
export function reverseStyleDictionary(sd, prefix = []) {
  if (sd && typeof sd === "object" && !Array.isArray(sd)) {
    if ("value" in sd && Object.keys(sd).length === 1) {
      return sd.value;
    }
    const out = {};
    for (const [k, v] of Object.entries(sd)) {
      out[k] = reverseStyleDictionary(v, [...prefix, k]);
    }
    return out;
  }
  return sd;
}
