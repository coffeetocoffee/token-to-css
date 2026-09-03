import { registerPlugin, resolveReferences, normalizeW3C } from "../index.js";

function inferType(value) {
  if (typeof value === "boolean") return "BOOLEAN";
  const v = String(value).trim();
  if (/^#|^rgba?\(|^hsla?\(/i.test(v)) return "COLOR";
  if (/^(px|rem|em|%|vh|vw|vmin|vmax|fr|pt|ch|ex|s|ms|deg|rad|turn)/i.test(v)) return "FLOAT";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "FLOAT";
  return "STRING";
}

/**
 * Convert a resolved token tree into a Figma-variable shaped document.
 * Each leaf becomes `{ name: "group/sub/leaf", type, valuesByMode: { "Base": value } }`.
 * Pure and transport-agnostic — usable for round-trip tests without the Figma API.
 */
export function tokensToFigmaVariables(tokens, options = {}) {
  const tree = resolveReferences(normalizeW3C(tokens), { reduce: true });
  const collection = options.collection || "Tokens";
  const out = [];
  function walk(node, path) {
    for (const [key, value] of Object.entries(node)) {
      const p = [...path, key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value, p);
      } else if (value !== null && value !== undefined) {
        out.push({
          name: p.join("/"),
          type: inferType(value),
          valuesByMode: { [options.mode || "Base"]: value },
        });
      }
    }
  }
  walk(tree, []);
  return { collections: [{ name: collection, modes: [options.mode || "Base"], variables: out }] };
}

/** Inverse of `tokensToFigmaVariables`. */
export function figmaVariablesToTokens(doc) {
  const out = {};
  for (const col of doc.collections || []) {
    for (const v of col.variables || []) {
      const mode = (col.modes && col.modes[0]) || "Base";
      const value = v.valuesByMode ? v.valuesByMode[mode] : undefined;
      if (value === undefined) continue;
      let cur = out;
      const parts = v.name.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = cur[parts[i]] || {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }
  }
  return out;
}

/**
 * Opt-in Figma connector. Registers a `figma` output format (so
 * `convert(tokens, { format: "figma" })` emits a Figma-variable document) and
 * returns a `push`/`pull` object that talks to the Figma REST API when a
 * `fetchImpl` is supplied. No hard dependency on Figma's SDK — it is an adapter
 * that plugs into the `serve` mesh.
 *
 * Experimental.
 */
export function registerFigmaConnector({ fetchImpl, token, fileKey } = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  registerPlugin({
    name: "figma",
    formats: {
      figma: (_flat, opts) => {
        const tree = opts && opts.resolvedBase ? opts.resolvedBase : {};
        return JSON.stringify(tokensToFigmaVariables(tree), null, 2);
      },
    },
  });

  async function push(tree) {
    if (!fetchFn) throw new Error("figma connector: no fetch implementation available");
    const doc = tokensToFigmaVariables(tree);
    const res = await fetchFn(`https://api.figma.com/v1/files/${fileKey}/variables`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-figma-token": token },
      body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error(`figma push failed: ${res.status}`);
    return res.json();
  }

  async function pull() {
    if (!fetchFn) throw new Error("figma connector: no fetch implementation available");
    const res = await fetchFn(`https://api.figma.com/v1/files/${fileKey}/variables`, {
      headers: { "x-figma-token": token },
    });
    if (!res.ok) throw new Error(`figma pull failed: ${res.status}`);
    const doc = await res.json();
    return figmaVariablesToTokens(doc);
  }

  return { push, pull, tokensToFigmaVariables, figmaVariablesToTokens };
}
