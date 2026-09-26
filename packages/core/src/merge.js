/**
 * Keys that can reach the prototype chain. A token tree is fully
 * attacker-controlled in several paths — connector `pull()` results, a
 * `POST /tokens` body, and an approved change-request's `proposed` payload all
 * flow into `deepMerge` — so assigning through one of these would pollute
 * `Object.prototype` process-wide. `Object.entries` does surface `__proto__`
 * for a parsed plain object, so the usual "entries skips it" defence does not
 * apply here: the guard has to be explicit.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Copy a value that is about to be assigned wholesale, dropping unsafe keys.
 * A `JSON.parse`d source can carry `__proto__` as a genuine *own* key (it is
 * enumerable), so assigning the object by reference would smuggle that key
 * into the output tree — where it would later flatten into a bogus token.
 * Primitives and arrays pass through unchanged.
 */
function safeCopy(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = safeCopy(v);
  }
  return out;
}

export function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = safeCopy(value);
    }
  }
  return target;
}

export function mergeTokens(main, imports) {
  const result = {};
  for (const doc of [...imports, main]) {
    deepMerge(result, doc);
  }
  return result;
}
