import { resolveReferences } from "./references.js";
import { deepMerge } from "./merge.js";

export const KNOWN_W3C_TYPES = new Set([
  "color",
  "dimension",
  "spacing",
  "fontFamily",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "string",
  "number",
  "boolean",
  "duration",
  "cubicBezier",
  "shadow",
  "border",
  "gradient",
  "strokeStyle",
  "opacity",
  "other",
]);

function kebab(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function refToFlat(ref) {
  return ref
    .split(".")
    .map((s) => kebab(s))
    .join("-");
}

function walkRaw(node, path, cb) {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    if ("$value" in node) {
      cb(path, node, true);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      walkRaw(v, [...path, k], cb);
    }
    return;
  }
  cb(path, node, false);
}

function flattenNormalized(input, prefix = []) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const path = [...prefix, kebab(key)];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenNormalized(value, path));
    } else if (value !== null && value !== undefined) {
      out[path.join("-")] = String(value);
    }
  }
  return out;
}

export function normalizeW3CLocal(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    if ("$value" in input) return input.$value;
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = normalizeW3CLocal(value);
    }
    return out;
  }
  return input;
}

function collectRefs(str, into) {
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(str))) into.add(m[1]);
}

/**
 * Lint a token tree. Returns { issues, errors, warnings }.
 * Rules:
 * - unknown-reference (error): a {ref} that does not resolve
 * - broken-type (error): unknown $type value
 * - dangling-brand-override (error): a brand override for a token missing in base
 * - untyped (warning): $value without $type
 * - unused (warning): token never referenced by another token
 * - duplicate-value (warning): same resolved value under 2+ names
 * - missing-brand-override (warning): token overridden in some brands but not others
 */
export function lintTokens(tokens, options = {}) {
  const issues = [];
  const push = (rule, message, path = null, severity = "warning") =>
    issues.push({ rule, message, path, severity });

  const raw = tokens && typeof tokens === "object" ? tokens : {};
  const tree = normalizeW3CLocal(raw);

  const modeKey = tree.modes ? "modes" : tree.themes ? "themes" : null;
  const brandKey = tree.brands ? "brands" : tree.brand ? "brand" : null;
  let baseTree = tree;
  if (modeKey) {
    baseTree = structuredClone(tree);
    delete baseTree[modeKey];
  }
  if (brandKey) {
    baseTree = structuredClone(baseTree);
    delete baseTree[brandKey];
  }
  const modeDefs = modeKey ? tree[modeKey] : null;
  const brandDefs = brandKey ? tree[brandKey] : null;

  // 1. $type checks + collect refs from raw string leaves
  const refs = new Set();
  walkRaw(raw, [], (path, node, isW3C) => {
    const dotted = path.join(".");
    if (isW3C) {
      if (!("$type" in node)) {
        push("untyped", `untyped token "${dotted}": $value without $type`, dotted, "warning");
      } else if (!KNOWN_W3C_TYPES.has(String(node.$type))) {
        push(
          "broken-type",
          `broken $type at "${dotted}": unknown type "${node.$type}"`,
          dotted,
          "error"
        );
      }
      if (typeof node.$value === "string") collectRefs(node.$value, refs);
      return;
    }
    if (typeof node === "string") collectRefs(node, refs);
  });

  // Also collect refs inside mode/brand overrides (they are part of raw walk already,
  // since walkRaw descends into modes/brands keys — but attribute them anyway).

  // 2. Resolve base to detect unknown references + build flat map
  let resolvedBase = null;
  try {
    resolvedBase = resolveReferences(baseTree, { reduce: true });
  } catch (err) {
    push("unknown-reference", String(err.message), null, "error");
  }
  // Also try resolving each mode merge so cross-mode refs surface
  if (modeDefs) {
    for (const [m, def] of Object.entries(modeDefs)) {
      try {
        const merged = structuredClone(baseTree);
        deepMerge(merged, def);
        resolveReferences(merged, { reduce: true });
      } catch (err) {
        push("unknown-reference", `mode "${m}": ${err.message}`, `modes.${m}`, "error");
      }
    }
  }
  if (brandDefs && typeof brandDefs === "object") {
    for (const [b, def] of Object.entries(brandDefs)) {
      if (!def || typeof def !== "object") continue;
      try {
        const merged = structuredClone(baseTree);
        deepMerge(merged, def);
        resolveReferences(merged, { reduce: true });
      } catch (err) {
        push("unknown-reference", `brand "${b}": ${err.message}`, `brands.${b}`, "error");
      }
    }
  }

  const flat = resolvedBase ? flattenNormalized(resolvedBase) : {};

  // 3. unused: flat tokens never referenced
  const referencedFlats = new Set();
  for (const r of refs) referencedFlats.add(refToFlat(r));
  if (!options.noUnused && refs.size > 0) {
    // Only report when the set actually references something; a file with
    // zero references at all would otherwise flag everything.
    for (const name of Object.keys(flat)) {
      if (!referencedFlats.has(name)) {
        push("unused", `unused token "${name}": never referenced by another token`, name, "warning");
      }
    }
  }

  // 4. duplicate values
  if (!options.noDuplicates) {
    const byValue = new Map();
    for (const [k, v] of Object.entries(flat)) {
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(k);
    }
    for (const [value, names] of byValue) {
      if (names.length > 1) {
        push(
          "duplicate-value",
          `duplicate value "${value}" shared by: ${names.join(", ")}`,
          names[0],
          "warning"
        );
      }
    }
  }

  // 5. brand override checks
  if (brandDefs && typeof brandDefs === "object") {
    const baseFlat = flattenNormalized(baseTree);
    const brandNames = Object.keys(brandDefs);
    const perBrand = {};
    for (const b of brandNames) {
      const def = brandDefs[b];
      perBrand[b] = def && typeof def === "object" ? flattenNormalized(def) : {};
    }
    for (const b of brandNames) {
      for (const key of Object.keys(perBrand[b])) {
        if (!(key in baseFlat)) {
          push(
            "dangling-brand-override",
            `brand "${b}" overrides unknown token "${key}"`,
            `brands.${b}.${key}`,
            "error"
          );
        }
      }
    }
    // missing: token overridden in >=1 brand but absent in another
    const overriddenAnywhere = new Set();
    for (const b of brandNames) for (const k of Object.keys(perBrand[b])) overriddenAnywhere.add(k);
    for (const key of overriddenAnywhere) {
      if (!(key in baseFlat)) continue; // already reported as dangling
      for (const b of brandNames) {
        if (!(key in perBrand[b])) {
          push(
            "missing-brand-override",
            `brand "${b}" is missing an override for "${key}" (overridden in another brand)`,
            `brands.${b}.${key}`,
            "warning"
          );
        }
      }
    }
  }

  lintEmptyGroups(raw, issues, options);

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity !== "error").length;
  return { issues, errors, warnings };
}

/**
 * Lint rule: detect groups (objects) that contain no token leaves — dead
 * branches that ship no CSS variables. Off when `options.noEmptyGroups`.
 */
function collectEmptyGroups(node, path, into) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if ("$value" in node) return;
  let anyLeaf = false;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object" && !Array.isArray(v) && !("$value" in v)) {
      collectEmptyGroups(v, [...path, k], into);
    } else {
      anyLeaf = true;
    }
  }
  if (!anyLeaf) into.push(path.join("."));
}

/** Augment `lintTokens` issues with empty-group findings. Mutates `issues`. */
export function lintEmptyGroups(tokens, issues, options = {}) {
  if (options.noEmptyGroups) return;
  const groups = [];
  collectEmptyGroups(tokens, [], groups);
  for (const g of groups) {
    issues.push({
      rule: "empty-group",
      message: `empty group "${g || "<root>"}" has no token leaves`,
      path: g || null,
      severity: "warning",
    });
  }
}

/**
 * Enforce a contract (JSON Schema, e.g. as emitted by `--format schema` with
 * added `required` arrays) against a token tree. Throws on violation.
 * Supports a subset: type, required, properties, additionalProperties.
 */
export function checkContract(tokens, schema) {
  const tree = normalizeW3CLocal(tokens);
  const errors = [];
  function checkType(value, expected, path) {
    if (expected == null) return true;
    const t = Array.isArray(expected) ? expected : [expected];
    const actual = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value;
    // schema uses "object" for groups, leaf types string/number/boolean
    if (t.includes(actual)) return true;
    // numbers/booleans serialized? be strict
    errors.push(`contract violation at "${path || "<root>"}": expected ${t.join("/")} but got ${actual}`);
    return false;
  }
  function walk(value, sch, path) {
    if (!sch || typeof sch !== "object") return;
    if (sch.type) checkType(value, sch.type, path);
    if (sch.required && Array.isArray(sch.required)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const req of sch.required) {
          if (!(req in value)) {
            errors.push(`contract violation: missing required token "${path ? `${path}.${req}` : req}"`);
          }
        }
      } else {
        errors.push(`contract violation at "${path || "<root>"}": required check on non-object`);
      }
    }
    if (sch.properties && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, sub] of Object.entries(sch.properties)) {
        if (k in value) walk(value[k], sub, path ? `${path}.${k}` : k);
      }
      if (sch.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!(k in sch.properties) && k !== "modes" && k !== "themes" && k !== "brands" && k !== "brand") {
            errors.push(`contract violation at "${path || "<root>"}": unexpected token "${k}"`);
          }
        }
      }
    }
  }
  walk(tree, schema, "");
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.name = "ContractViolationError";
    throw err;
  }
  return true;
}
