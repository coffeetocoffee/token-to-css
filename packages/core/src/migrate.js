import { resolveReferences } from "./references.js";
import { normalizeW3C } from "./index.js";

/**
 * Build a reverse-dependency graph from a token tree.
 * Returns `{ [tokenPath]: string[] }` where each value is the list of tokens
 * that directly reference the key token.
 */
export function getImpactGraph(tokens) {
  const normalized = normalizeW3C(tokens);
  const flat = flattenDotted(normalized);
  const allNames = new Set(Object.keys(flat));
  const usedBy = {};
  const refRe = /\{([\w.]+)\}/g;

  for (const [name, value] of Object.entries(flat)) {
    if (typeof value !== "string") continue;
    let m;
    while ((m = refRe.exec(value))) {
      const target = m[1];
      if (allNames.has(target)) {
        if (!usedBy[target]) usedBy[target] = [];
        usedBy[target].push(name);
      }
    }
    refRe.lastIndex = 0;
  }

  return usedBy;
}

/**
 * Get all transitive dependents of a token (direct + indirect references).
 */
export function getTransitiveDependents(tokens, tokenPath) {
  const graph = getImpactGraph(tokens);
  const visited = new Set();
  const queue = [tokenPath];

  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const deps = graph[current] || [];
    for (const dep of deps) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  visited.delete(tokenPath);
  return [...visited];
}

/**
 * Generate a codemod that renames a token and updates all references.
 */
export function generateCodemod(tokens, { from, to }) {
  const normalized = normalizeW3C(tokens);
  const flat = flattenDotted(normalized);
  const graph = getImpactGraph(tokens);
  const refRe = new RegExp(`\\{${escapeRegex(from)}\\}`, "g");

  const operations = [];

  operations.push({
    type: "rename",
    from,
    to,
  });

  const dependents = getTransitiveDependents(tokens, from);
  for (const dep of dependents) {
    const value = flat[dep];
    if (typeof value === "string" && refRe.test(value)) {
      operations.push({
        type: "update-ref",
        path: dep,
        oldRef: `{${from}}`,
        newRef: `{${to}}`,
      });
      refRe.lastIndex = 0;
    }
  }

  return {
    version: "1.0.0",
    operations,
    impact: {
      direct: (graph[from] || []).length,
      transitive: dependents.length,
    },
  };
}

/**
 * Apply a codemod to a token tree.
 */
export function applyCodemod(tokens, codemod) {
  let tree = structuredClone(tokens);
  const changes = [];

  for (const op of codemod.operations) {
    if (op.type === "rename") {
      const value = getByPath(tree, op.from.split("."));
      if (value !== undefined) {
        setByPath(tree, op.to.split("."), value);
        setByPath(tree, op.from.split("."), undefined);
        changes.push({ type: "rename", from: op.from, to: op.to });
      }
    } else if (op.type === "update-ref") {
      const parts = op.path.split(".");
      let node = tree;
      for (const p of parts) {
        if (!node[p]) node[p] = {};
        node = node[p];
      }
      if (node && typeof node === "object" && "$value" in node && typeof node.$value === "string") {
        node.$value = node.$value.replace(op.oldRef, op.newRef);
        changes.push({ type: "update-ref", path: op.path });
      } else if (typeof node === "string") {
        const parentParts = parts.slice(0, -1);
        const leaf = parts[parts.length - 1];
        let parentNode = tree;
        for (const p of parentParts) {
          if (!parentNode[p]) parentNode[p] = {};
          parentNode = parentNode[p];
        }
        if (typeof parentNode[leaf] === "string") {
          parentNode[leaf] = parentNode[leaf].replace(op.oldRef, op.newRef);
          changes.push({ type: "update-ref", path: op.path });
        }
      }
    }
  }

  return { tree, changes };
}

/**
 * Generate a CSS codemod (find/replace pairs) for updating CSS files.
 */
export function generateCSSCodemod(css, registry, { from, to }) {
  const fromCanonical = registry ? registry.canonicalOf(from.split(".")) : from.replace(/\./g, "-");
  const toCanonical = registry ? registry.canonicalOf(to.split(".")) : to.replace(/\./g, "-");

  return {
    version: "1.0.0",
    type: "css",
    operations: [
      {
        type: "find-replace",
        find: `--${fromCanonical}`,
        replace: `--${toCanonical}`,
      },
    ],
  };
}

function flattenDotted(input, prefix = []) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const path = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$value" in value) {
        out[path.join(".")] = value.$value;
      } else {
        Object.assign(out, flattenDotted(value, path));
      }
    } else if (value !== null && value !== undefined) {
      out[path.join(".")] = String(value);
    }
  }
  return out;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getByPath(node, path) {
  let cur = node;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setByPath(node, path, value) {
  let cur = node;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  if (value === undefined) {
    delete cur[path[path.length - 1]];
  } else {
    cur[path[path.length - 1]] = value;
  }
}
