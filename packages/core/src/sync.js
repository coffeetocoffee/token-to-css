import { flattenTokens } from "./index.js";

function splitPath(flatName) {
  return flatName.split("-");
}

/**
 * Can the flat name `a-b-c` be set on `node` without clobbering an existing
 * leaf? i.e. every prefix path is either absent or already an object. Walks
 * and (as a side effect) creates missing intermediate objects so the caller can
 * assign. Returns false on a kebab collision (a prefix that is already a leaf),
 * which is exactly the lossy case `reverse` cannot resolve.
 */
export function canSetPath(node, flatName) {
  const parts = splitPath(flatName);
  let cur = node;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null) {
      cur[p] = {};
    } else if (typeof cur[p] !== "object" || Array.isArray(cur[p])) {
      return false;
    }
    cur = cur[p];
  }
  return true;
}

function setValueByPath(node, flatName, value) {
  const parts = splitPath(flatName);
  let cur = node;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Fold a reversed (CSS/SCSS → tree) artifact back into the source token tree.
 * Applies only values that resolve unambiguously (no kebab collisions); colliding
 * names are reported in `skipped` and left untouched, keeping `tokens.json`
 * authoritative and the operation idempotent.
 */
export function applyReversedIntoSource(source, reversed) {
  const out = structuredClone(source);
  const changed = [];
  const skipped = [];
  function mergeInto(targetNode, revNode) {
    const sf = flattenTokens(targetNode);
    const rf = flattenTokens(revNode);
    for (const [name, val] of Object.entries(rf)) {
      if (sf[name] === val) continue;
      if (!canSetPath(targetNode, name)) {
        skipped.push(name);
        continue;
      }
      setValueByPath(targetNode, name, val);
      changed.push(name);
    }
  }
  mergeInto(out, reversed);
  for (const key of ["modes", "brands"]) {
    if (reversed[key]) {
      out[key] = out[key] || {};
      for (const sub of Object.keys(reversed[key])) {
        out[key][sub] = out[key][sub] || {};
        mergeInto(out[key][sub], reversed[key][sub]);
      }
    }
  }
  return { source: out, changed, skipped };
}

/**
 * Compute the drift between the source tree and a reversed artifact: which flat
 * tokens were added / changed in the artifact relative to the source. Grouped by
 * `base`, `modes.<name>`, `brands.<name>`.
 */
export function computeDrift(source, reversed) {
  const result = {};
  function diffInto(label, srcNode, revNode) {
    const sf = flattenTokens(srcNode || {});
    const rf = flattenTokens(revNode || {});
    const added = {};
    const changed = {};
    for (const [k, v] of Object.entries(rf)) {
      if (!(k in sf)) added[k] = v;
      else if (sf[k] !== v) changed[k] = { from: sf[k], to: v };
    }
    result[label] = { added, changed };
  }
  diffInto("base", source, reversed);
  for (const key of ["modes", "brands"]) {
    if (reversed[key]) {
      for (const sub of Object.keys(reversed[key])) {
        diffInto(`${key}.${sub}`, source[key]?.[sub] || {}, reversed[key][sub]);
      }
    }
  }
  return result;
}
