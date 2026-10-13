let nextCrId = 1;

/**
 * Advance the id counter past every id in `requests` so ids issued after a
 * restart cannot collide with reloaded ones.
 *
 * `nextCrId` is module state, so a fresh process starts at 1 while the
 * persisted log already contains `cr-1`. Approval resolves by id
 * (`changeRequests.find(c => c.id === crId)`, first match wins), so a collision
 * silently applies the OLD proposal — a wrong write to the source of truth.
 * Call this with the reloaded log right after loading it.
 *
 * Non-numeric / unparsable ids (e.g. `cr-<uuid>`) are ignored rather than
 * throwing: a hand-edited log must not break boot.
 *
 * @param {Array<{ id?: string }>} [requests]
 * @returns {number} the next id that will be issued
 */
export function seedChangeRequestIds(requests) {
  if (!Array.isArray(requests)) return nextCrId;
  for (const cr of requests) {
    const m = /^cr-(\d+)$/.exec(String(cr && cr.id));
    if (m) {
      const n = Number(m[1]) + 1;
      if (n > nextCrId) nextCrId = n;
    }
  }
  return nextCrId;
}

/**
 * Keys that can reach the prototype chain. `cr.proposed` is attacker-supplied
 * and is deep-merged into the source tree by `applyChangeRequest`, so it needs
 * the same guard as `merge.js` — an unguarded assign through `__proto__` would
 * pollute `Object.prototype` process-wide.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function safeCopy(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = safeCopy(v);
  }
  return out;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
    } else {
      target[key] = safeCopy(value);
    }
  }
}
