/**
 * Generic CMS connector (v8.0 Universal Connector Hub).
 *
 * Mirrors tokens into a headless CMS as content entries (Contentful/Sanity-style
 * "token" records). Each leaf token becomes one entry keyed by its dotted path;
 * `pull` reads them back into a token tree. Intentionally transport-agnostic:
 * point `url` at any REST endpoint that stores/returns an entries array.
 *
 * Pure transforms (`tokensToCmsEntries` / `cmsEntriesToTokens`) are
 * transport-agnostic and unit-testable without a network. `push`/`pull` talk to
 * the CMS REST API when a `fetchImpl` is supplied.
 *
 * Experimental.
 */
import { toTransportTree, registerConnector } from "./connect.js";

function inferType(value) {
  if (typeof value === "boolean") return "boolean";
  const v = String(value).trim();
  if (/^#|^rgba?\(|^hsla?\(/i.test(v)) return "color";
  if (/^(px|rem|em|%|vh|vw|vmin|vmax|fr|pt|ch|ex|s|ms|deg|rad|turn)/i.test(v)) return "dimension";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  return "string";
}

export function tokensToCmsEntries(tokens) {
  const tree = toTransportTree(tokens);
  const out = [];
  function walk(node, path) {
    for (const [key, value] of Object.entries(node)) {
      const p = [...path, key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value, p);
      } else if (value !== null && value !== undefined) {
        const id = p.join(".");
        out.push({
          id,
          fields: { value, type: inferType(value), path: id },
        });
      }
    }
  }
  walk(tree, []);
  return out;
}

export function cmsEntriesToTokens(entries) {
  const out = {};
  for (const entry of entries || []) {
    const id = entry.id || (entry.fields && entry.fields.path);
    const value = entry.fields ? entry.fields.value : undefined;
    if (!id || value === undefined) continue;
    const parts = id.split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

export function registerCmsConnector({ fetchImpl, url, token, type = "token" } = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  function headers(extra = {}) {
    return {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  async function pull() {
    if (!fetchFn) throw new Error("cms connector: no fetch implementation available");
    if (!url) throw new Error("cms connector: no url configured");
    const res = await fetchFn(`${url}/entries?type=${encodeURIComponent(type)}`, { headers: headers() });
    if (!res.ok) throw new Error(`cms pull failed: ${res.status}`);
    return cmsEntriesToTokens(await res.json());
  }

  async function push(tree) {
    if (!fetchFn) throw new Error("cms connector: no fetch implementation available");
    if (!url) throw new Error("cms connector: no url configured");
    const entries = tokensToCmsEntries(tree);
    const res = await fetchFn(`${url}/entries`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(entries),
    });
    if (!res.ok) throw new Error(`cms push failed: ${res.status}`);
    return res.json();
  }

  registerConnector({
    name: "cms",
    pull,
    push,
    formats: {
      cms: (_flat, opts) => {
        const tree = opts && opts.resolvedBase ? opts.resolvedBase : {};
        return JSON.stringify(tokensToCmsEntries(tree), null, 2);
      },
    },
  });
  return { pull, push, tokensToCmsEntries, cmsEntriesToTokens };
}
