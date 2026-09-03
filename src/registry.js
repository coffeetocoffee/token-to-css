import { normalizeW3C, resolveReferences } from "./index.js";

function kebab(str) {
  return String(str)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function makeRegistry(entries, pathToCanonical, canonicalToPath) {
  return {
    entries,
    canonicalOf(path) {
      return pathToCanonical.get(path.join("\u0000")) || path.map(kebab).join("-");
    },
    pathOf(canonical) {
      return canonicalToPath.get(canonical) || null;
    },
    has(canonical) {
      return canonicalToPath.has(canonical);
    },
    toJSON() {
      return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        name: "token-to-css name registry",
        version: 1,
        names: entries.map((e) => ({ path: e.path.join("."), canonical: e.canonical })),
      };
    },
  };
}

/**
 * Build a canonical name registry for a token tree.
 *
 * The registry is the piece that makes the CSS/SCSS round-trip provably
 * lossless: every token path (color.primary, color.primaryHover, ...) gets a
 * unique canonical flat name, and the mapping is invertible. convert emits
 * --<canonical> and reverse (given the same registry) maps it straight back to
 * the original path with no kebab un-flattening, so collisions (e.g. a
 * color.primary leaf vs a color.primary.hover nested branch) no longer drop a
 * branch.
 *
 * The registry is emitted as tokens.names.json alongside outputs so sync,
 * reverse, and serve can trust every inbound edit.
 */
export function buildNameRegistry(tokens, options = {}) {
  const tree =
    options.resolve === false
      ? normalizeW3C(tokens)
      : resolveReferences(normalizeW3C(tokens), { reduce: true });
  const pathToCanonical = new Map();
  const canonicalToPath = new Map();
  const entries = [];

  function walk(node, path) {
    for (const [key, value] of Object.entries(node)) {
      const p = [...path, key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value, p);
      } else if (value !== null && value !== undefined) {
        entries.push({ path: p, value: String(value) });
      }
    }
  }
  walk(tree, []);

  const used = new Set();
  for (const e of entries) {
    const base = e.path.map((s) => kebab(s)).join("-");
    let cand = base;
    let n = 2;
    while (used.has(cand)) cand = `${base}-${n++}`;
    used.add(cand);
    e.canonical = cand;
    pathToCanonical.set(e.path.join("\u0000"), cand);
    canonicalToPath.set(cand, e.path);
  }

  return makeRegistry(entries, pathToCanonical, canonicalToPath);
}

/** Read a registry previously emitted with registry.toJSON(). */
export function registryFromJSON(json) {
  const pathToCanonical = new Map();
  const canonicalToPath = new Map();
  const entries = [];
  for (const { path, canonical } of json.names) {
    const p = path.split(".");
    entries.push({ path: p, canonical });
    pathToCanonical.set(p.join("\u0000"), canonical);
    canonicalToPath.set(canonical, p);
  }
  return makeRegistry(entries, pathToCanonical, canonicalToPath);
}

/** Set node[path[0]][path[1]]... = value, creating intermediate objects. */
export function setByPath(node, path, value) {
  let cur = node;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[path[path.length - 1]] = value;
}

/** Get node[path[0]][path[1]]..., or undefined if any segment is missing. */
export function getByPath(node, path) {
  let cur = node;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
