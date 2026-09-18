/**
 * v15 — AI-native token ops: the heuristic layer behind the MCP sampling tools.
 *
 * Everything here is zero-dep, side-effect-free suggestion/explain machinery:
 * an agent (or the playground) supplies judgment; this module supplies the
 * tree-aware facts — the names the linter would accept, the groupings the
 * registry can round-trip, a lexical search over the tree, and the provenance
 * behind a token. Proposals never mutate: `groupTokens` returns a tree clone.
 */
import {
  normalizeW3C,
  resolveReferences,
  parseColor,
  getImpactGraph,
  getTransitiveDependents,
  getDeprecations,
  generateCodemod,
  applyCodemod,
  getByPath,
} from "@token-to-css/core";

const RESERVED_KEYS = new Set(["modes", "themes", "brands", "brand", "teams"]);
const DIMENSION_RE = /^\s*-?\d*\.?\d+(px|rem|em|%|pt|vh|vw|ch|ex|fr|vmin|vmax)\s*$/;
const REF_RE = /\{([\w.:-]+)\}/g;

function kebab(str) {
  return String(str)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/** Flatten a RAW tree (W3C `$value` leaves included) to dotted -> raw value. */
function flattenRaw(input, prefix = [], out = {}) {
  for (const [key, value] of Object.entries(input || {})) {
    const path = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$value" in value) out[path.join(".")] = value.$value;
      else flattenRaw(value, path, out);
    } else if (value !== null && value !== undefined) {
      out[path.join(".")] = value;
    }
  }
  return out;
}

/** Flatten a RAW tree to dotted -> leaf node object (keeps deprecated/$type). */
function flattenNodes(input, prefix = [], out = {}) {
  for (const [key, value] of Object.entries(input || {})) {
    const path = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$value" in value) out[path.join(".")] = value;
      else flattenNodes(value, path, out);
    } else if (value !== null && value !== undefined) {
      out[path.join(".")] = { $value: value };
    }
  }
  return out;
}

function kindOf(value) {
  const str = String(value ?? "").trim();
  if (!str) return "text";
  if (parseColor(str)) return "color";
  if (DIMENSION_RE.test(str)) return "dimension";
  if (/^#|rgba?\(|hsla?\(|oklch|oklab|\blab\(|\blch\(/i.test(str)) return "color";
  return "text";
}

function variableOf(path) {
  return `--${path.split(".").map(kebab).join("-")}`;
}

/** Does a dotted path resolve to an existing leaf in the raw tree? */
function leafExists(nodes, path) {
  return Object.prototype.hasOwnProperty.call(nodes, path);
}

// --- suggest-name ----------------------------------------------------------

/**
 * Suggest a well-formed token name — the name the linter and the registry
 * would accept: kebab-clean segments, under the right group, colliding names
 * disambiguated with the registry's own `-N` rule (so the round-trip stays
 * lossless and `duplicate-value`/kebab-collision lints stay quiet).
 *
 * `path` renames an existing token (its group is preserved); `value` names a
 * new one (the group is `group`, or inferred from kind, or an existing
 * same-kind group).
 *
 * Returns `{ name, segments, variable, available, conflicts, reason }`.
 */
export function suggestTokenName(tokens, options = {}) {
  const raw = tokens || {};
  const nodes = flattenNodes(raw);
  const base = resolveReferences(normalizeW3C(raw), { reduce: true });
  const flatBase = flattenRaw(base);
  const existingGroups = new Set(
    Object.keys(flatBase).map((p) => p.split(".")[0]).filter(Boolean)
  );

  let group = options.group ? kebab(options.group) : null;
  let leaf = null;
  const reason = [];

  if (options.path) {
    // Rename: keep the token under its existing group, re-spell the leaf.
    const src = String(options.path);
    const node = nodes[src];
    if (!node) {
      return {
        name: null,
        reason: `unknown token: ${src}`,
        available: false,
        conflicts: [],
      };
    }
    const parts = src.split(".");
    group = parts.length > 1 ? parts.slice(0, -1).map(kebab).join(".") : null;
    leaf = kebab(parts[parts.length - 1]);
    if (options.value === undefined) options = { ...options, value: node.$value };
    reason.push(`rename of ${src}`);
  } else {
    leaf = kebab(String(options.label || "").trim()) || null;
  }

  const value = options.value;
  const kind = value !== undefined ? kindOf(value) : "text";

  if (!group) {
    if (kind === "color" && existingGroups.has("color")) group = "color";
    else if (kind === "dimension" && existingGroups.has("space")) group = "space";
    else if (kind === "dimension" && existingGroups.has("size")) group = "size";
    else if (existingGroups.has(kind)) group = kind;
    else group = kind === "color" ? "color" : kind === "dimension" ? "size" : "text";
    reason.push(`inferred group "${group}" from kind ${kind}`);
  } else {
    reason.push(`group ${group}`);
  }

  // A color value with no better hint can carry its hex as a readable leaf.
  if (!leaf && value !== undefined) {
    const parsed = parseColor(String(value).trim());
    if (parsed) {
      const hex = formatHex(parsed);
      leaf = hex.replace("#", "");
      reason.push(`leaf derived from value ${hex}`);
    }
  }
  if (!leaf) leaf = kind;
  leaf = leaf.replace(/^-+|-+$/g, "");
  if (!leaf) leaf = "token";

  const segments = group ? group.split(".").concat(leaf) : [leaf];
  let name = segments.join(".");
  let variable = variableOf(name);
  let n = 2;
  const conflicts = [];
  // Registry disambiguation: `base`, `base-2`, `base-3`… on the flat name.
  while (leafExists(nodes, name)) {
    conflicts.push(name);
    name = [...segments.slice(0, -1), `${leaf}-${n}`].join(".");
    variable = variableOf(name);
    n++;
  }

  return {
    name,
    segments: name.split("."),
    variable,
    kind,
    available: !leafExists(nodes, name),
    conflicts,
    reason: reason.join("; "),
  };
}

function formatHex({ r, g, b, a }) {
  const toHex = (n) => Math.round(n).toString(16).padStart(2, "0");
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return a >= 1 ? hex : `${hex}${toHex(a * 255)}`;
}

// --- search ----------------------------------------------------------------

/**
 * Lexical semantic search over the tree (zero-dep; embeddings are optional and
 * out of scope here). Query terms match path segments, the variable name, the
 * kind, and the value; exact-segment hits outrank prefixes, prefixes outrank
 * fuzzy subsequence matches. A token matching *every* term gets a completeness
 * bonus, so "primary color" ranks color.primary above color.primaryHover.
 *
 * Returns `{ query, results: [{ path, value, variable, kind, score, matched }], total }`.
 */
export function searchTokens(tokens, query, options = {}) {
  const max = Math.max(1, Number(options.max) || 20);
  const tree = resolveReferences(normalizeW3C(tokens || {}), { reduce: true });
  const flat = flattenRaw(tree);
  const nodes = flattenNodes(tokens || {});

  const terms = String(query || "")
    .split(/[\s_.\-/]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) {
    return { query: String(query || ""), results: [], total: 0 };
  }

  const results = [];
  for (const [path, value] of Object.entries(flat)) {
    const segments = path.split(".").map((s) => s.toLowerCase());
    const variable = variableOf(path).slice(2);
    const kind = kindOf(value);
    const hay = {
      segments,
      variable,
      kind,
      value: String(value).toLowerCase(),
    };
    let score = 0;
    const matched = [];
    for (const term of terms) {
      let best = 0;
      let where = null;
      for (const seg of segments) {
        if (seg === term) {
          best = 8;
          where = `segment "${seg}"`;
          break;
        }
        if (seg.startsWith(term)) {
          if (best < 5) {
            best = 5;
            where = `segment "${seg}"`;
          }
        } else if (subsequence(term, seg) && best < 3) {
          best = 3;
          where = `segment "${seg}"`;
        }
      }
      if (best === 0 && hay.variable.includes(term)) {
        best = 4;
        where = "variable";
      }
      if (best === 0 && hay.kind === term) {
        best = 4;
        where = "kind";
      }
      if (best === 0 && hay.value.includes(term)) {
        best = 2;
        where = "value";
      }
      if (best > 0) {
        score += best;
        matched.push(where);
      }
    }
    if (score === 0) continue;
    if (matched.length === terms.length) score = Math.round(score * 1.5);
    // Exact path lookup always wins.
    if (path.toLowerCase() === String(query || "").trim().toLowerCase()) score += 100;
    results.push({ path, value, variable: `--${variable}`, kind, score, matched });
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    query: String(query),
    results: results.slice(0, max),
    total: results.length,
  };
}

function subsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (needle[i] === haystack[j]) i++;
  }
  return i === needle.length;
}

// --- explain ---------------------------------------------------------------

/**
 * Provenance behind one token: raw + resolved value, kind and color swatch,
 * the references it consumes, the references that consume it (v7 impact
 * graph), deprecation state, per-mode/brand overrides, and the `$version`
 * stamp — everything an agent needs to answer "what is this token and what
 * happens if I touch it". Unknown paths return `null`.
 */
export function explainToken(tokens, path) {
  const raw = tokens || {};
  const nodes = flattenNodes(raw);
  const node = nodes[path];
  if (!node) return null;

  const value = node.$value;
  const kind = kindOf(value);
  const resolved = resolveReferences(normalizeW3C(structuredClone(raw)), { reduce: true });
  const resolvedValue = getByPath(resolved, path.split("."));
  const graph = getImpactGraph(raw);
  const direct = graph[path] || [];
  const transitive = getTransitiveDependents(raw, path);
  const deprecation = getDeprecations(raw).find((d) => d.path === path) || null;
  const parsed = parseColor(String(value).trim()) || null;

  const refs = [];
  {
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(String(value)))) refs.push(m[1]);
  }

  // Same path under every mode/brand that overrides it.
  const overrides = [];
  const scopes = [
    ...(raw.modes ? [["modes", raw.modes]] : raw.themes ? [["themes", raw.themes]] : []),
    ...(raw.brands ? [["brands", raw.brands]] : raw.brand ? [["brands", raw.brand]] : []),
  ];
  for (const [scopeKey, scopeTree] of scopes) {
    for (const [name, sub] of Object.entries(scopeTree || {})) {
      const subNodes = flattenNodes(sub);
      if (subNodes[path]) overrides.push({ scope: `${scopeKey}:${name}`, value: subNodes[path].$value });
    }
  }

  const parts = path.split(".");
  const summary = [
    `${path} is a ${kind} token`,
    `resolves to ${resolvedValue !== undefined ? resolvedValue : value}`,
    direct.length || transitive.length
      ? `used by ${direct.length} direct + ${transitive.length} transitive dependents`
      : "no dependents",
    deprecation ? `deprecated${deprecation.replacedBy ? ` — replace with ${deprecation.replacedBy}` : ""}` : "not deprecated",
  ].join("; ");

  return {
    path,
    value,
    resolved: resolvedValue,
    variable: variableOf(path),
    kind,
    color: parsed ? { hex: formatHex(parsed) } : null,
    group: parts.length > 1 ? parts[0] : null,
    refs,
    usedBy: { direct, transitive },
    deprecated: Boolean(deprecation),
    replacedBy: deprecation ? deprecation.replacedBy : null,
    overrides,
    version: node.$version || null,
    summary,
  };
}

// --- grouping --------------------------------------------------------------

/**
 * Propose groupings for the tree — sets of tokens that belong under one
 * parent. `by` selects the heuristic:
 * - `"value"` (default): tokens sharing an identical resolved value;
 * - `"kind"`: same kind (color/dimension/text) under a same-named group;
 * - `"prefix"`: tokens already sharing a two-segment prefix.
 *
 * Proposals only; nothing moves until `groupTokens` (or an agent) acts.
 */
export function proposeGrouping(tokens, options = {}) {
  const by = options.by || "value";
  const tree = resolveReferences(normalizeW3C(tokens || {}), { reduce: true });
  const flat = flattenRaw(tree);
  const buckets = new Map();

  const keyOf = (path, value) => {
    if (by === "value") return `value:${value}`;
    if (by === "kind") return `kind:${kindOf(value)}`;
    const parts = path.split(".");
    return parts.length > 1 ? `prefix:${parts.slice(0, 2).join(".")}` : null;
  };

  for (const [path, value] of Object.entries(flat)) {
    const key = keyOf(path, value);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(path);
  }

  const groups = [];
  for (const [key, paths] of buckets) {
    if (paths.length < 2) continue;
    const [kind, payload] = key.split(":");
    groups.push({
      name: kind === "value" ? `shared-${kebab(payload).slice(0, 24)}` : kebab(payload),
      paths: paths.sort(),
      reason:
        kind === "value"
          ? `${paths.length} tokens share the value ${JSON.stringify(payload)}`
          : kind === "kind"
            ? `${paths.length} ${payload} tokens`
            : `${paths.length} tokens under ${payload}`,
    });
  }
  groups.sort((a, b) => b.paths.length - a.paths.length);
  return { by, groups };
}

/**
 * Move token paths under a common parent (a proposal — the source tree is
 * never mutated). Each move is a rename the v7 codemod engine rewrites
 * references for, so a grouping lands as one migration request with its
 * codemod attached. Collisions disambiguate with the registry `-N` rule.
 *
 * `into` defaults to a proposed grouping (`by`) when omitted.
 * Returns `{ into, operations, tree, codemod, conflicts }`.
 */
export function groupTokens(tokens, options = {}) {
  const raw = tokens || {};
  let { paths = [], into = null, by = "value" } = options;
  paths = (Array.isArray(paths) ? paths : []).filter(Boolean);

  if (paths.length && !into) {
    const kind = kindOf(flattenRaw(raw)[paths[0]]);
    into = kind === "color" ? "color" : kind === "dimension" ? "size" : "shared";
  }
  if (!paths.length) {
    const proposal = proposeGrouping(raw, { by });
    const top = proposal.groups[0];
    if (!top) return { into: into || null, operations: [], tree: structuredClone(raw), codemod: null, conflicts: [] };
    paths = top.paths;
    into = into || top.name;
  }
  if (!into) return { into: null, operations: [], tree: structuredClone(raw), codemod: null, conflicts: [] };
  into = into
    .split(".")
    .map((s) => kebab(s))
    .join(".");

  const nodes = flattenNodes(raw);
  const operations = [];
  const conflicts = [];
  const used = new Set(Object.keys(nodes));
  const moves = [];

  for (const from of paths) {
    if (!leafExists(nodes, from)) {
      conflicts.push({ from, reason: "unknown token" });
      continue;
    }
    const leaf = from.split(".").pop();
    let to = `${into}.${leaf}`;
    let n = 2;
    while (used.has(to) && to !== from) {
      to = `${into}.${leaf}-${n++}`;
    }
    if (to === from) {
      conflicts.push({ from, reason: "already in target group" });
      continue;
    }
    used.add(to);
    moves.push({ from, to });
  }
  if (!moves.length) {
    return { into, operations: [], tree: structuredClone(raw), codemod: null, conflicts };
  }

  // Apply the moves sequentially: each move is a v7 codemod (rename +
  // update-refs) generated against the running tree, so references to a
  // moved token rewrite before the next move runs.
  let tree = structuredClone(raw);
  const codemod = { version: "1.0.0", operations: [], impact: { moves: moves.length } };
  for (const { from, to } of moves) {
    const moveCodemod = generateCodemod(tree, { from, to });
    const applied = applyCodemod(tree, moveCodemod);
    tree = applied.tree;
    operations.push({ type: "rename", from, to });
    for (const op of moveCodemod.operations) {
      if (op.type === "update-ref") codemod.operations.push(op);
    }
  }

  return { into, operations, tree, codemod, conflicts };
}
