let nextCrId = 1;

/**
 * Stamp a `$version` field on every leaf token in a tree.
 * Leaves that already have `$version` are left untouched.
 */
export function addVersionMarkers(tokens, version) {
  const out = structuredClone(tokens);
  function walk(node) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      if ("$value" in node) {
        if (!node.$version) node.$version = version;
      } else {
        for (const v of Object.values(node)) walk(v);
      }
    }
  }
  walk(out);
  return out;
}

/**
 * Walk a token tree and collect all tokens that have `deprecated: true`.
 * Returns an array of `{ path, replacedBy, value }` objects.
 */
export function getDeprecations(tokens) {
  const results = [];
  function walk(node, prefix) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      if ("$value" in node) {
        if (node.deprecated) {
          results.push({
            path: prefix.join("."),
            replacedBy: node.replacedBy || null,
            value: node.$value,
          });
        }
      } else {
        for (const [key, value] of Object.entries(node)) {
          walk(value, [...prefix, key]);
        }
      }
    }
  }
  walk(tokens, []);
  return results;
}

/**
 * Create a change-request object describing a proposed token mutation.
 */
export function createChangeRequest(current, proposed, { author = "anonymous", reason = "" } = {}) {
  return {
    id: `cr-${nextCrId++}`,
    status: "pending",
    author,
    reason,
    created: new Date().toISOString(),
    current: structuredClone(current),
    proposed: structuredClone(proposed),
  };
}

/**
 * Mark a change-request as approved.
 */
export function approveChangeRequest(cr, { approver = "system" } = {}) {
  if (cr.status !== "pending") throw new Error(`CR ${cr.id} is ${cr.status}, not pending`);
  cr.status = "approved";
  cr.approved = new Date().toISOString();
  cr.approver = approver;
  return cr;
}

/**
 * Mark a change-request as rejected.
 */
export function rejectChangeRequest(cr, reason = "", { rejectedBy = "system" } = {}) {
  if (cr.status !== "pending") throw new Error(`CR ${cr.id} is ${cr.status}, not pending`);
  cr.status = "rejected";
  cr.rejected = new Date().toISOString();
  cr.rejectedBy = rejectedBy;
  cr.rejectionReason = reason;
  return cr;
}

/**
 * Apply an approved change-request to a source token tree.
 * The `proposed` tree from the CR is deep-merged into source.
 */
export function applyChangeRequest(source, cr) {
  if (cr.status !== "approved") throw new Error(`CR ${cr.id} is not approved`);
  const out = structuredClone(source);
  deepMerge(out, cr.proposed);
  return { tree: out, cr };
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}
