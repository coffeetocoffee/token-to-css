/**
 * Universal Connector Hub (v8.0).
 *
 * A connector is the v8 extension contract for shipping tokens to/from an
 * external system (design tools, storybook, git, a CMS, ...). It is a thin
 * adapter that the rest of the library treats uniformly:
 *
 *   registerConnector({ name, pull, push, formats? })
 *
 * - `pull(ctx?)`  -> Promise<Tokens>   fetch the current token tree from the
 *                                         external system.
 * - `push(tree, ctx?)` -> Promise<unknown>  send a token tree to the external
 *                                         system.
 * - `formats?`   optional map of `{ fmtName: (flat, opts) => string }` output
 *                formats registered via `registerFormat` (so
 *                `convert(tokens, { format }) works).
 *
 * Connectors registered here are enumerated by `serve` so a token change can
 * round-trip end-to-end through the mesh (`POST /connectors/<name>/pull|push`)
 * with zero core changes: adding a new connector never touches `index.js`,
 * `references.js`, `serve.js` dispatch, or the conversion core.
 *
 * Connectors depend only on the public core surface (`registerFormat`,
 * `resolveReferences`, `normalizeW3C`) so they ship independently.
 */
import { registerFormat, resolveReferences, normalizeW3C } from "./index.js";

/** Resolve + reduce a token tree for transport to an external system. */
export function toTransportTree(tokens) {
  return resolveReferences(normalizeW3C(tokens), { reduce: true });
}

const registeredConnectors = {};

/**
 * Register a connector with the Universal Connector Hub.
 * Returns the connector (for chaining). Throws on a malformed connector.
 */
export function registerConnector(connector) {
  if (!connector || typeof connector !== "object")
    throw new Error("registerConnector expects a connector object");
  if (typeof connector.name !== "string")
    throw new Error("connector.name must be a string");
  if (typeof connector.pull !== "function")
    throw new Error("connector.pull must be a function");
  if (typeof connector.push !== "function")
    throw new Error("connector.push must be a function");
  const name = connector.name.toLowerCase();
  registeredConnectors[name] = connector;
  if (connector.formats) {
    for (const [fmt, fn] of Object.entries(connector.formats)) {
      registerFormat(fmt, fn);
    }
  }
  return connector;
}

/** Look up a registered connector by name (case-insensitive). */
export function getConnector(name) {
  return name ? registeredConnectors[String(name).toLowerCase()] : undefined;
}

/** List the names of all registered connectors. */
export function listConnectors() {
  return Object.keys(registeredConnectors);
}

/** Pull the current token tree from a registered connector. */
export async function connectorPull(name, ctx) {
  const c = getConnector(name);
  if (!c) throw new Error(`connector not found: ${name}`);
  return c.pull(ctx);
}

/** Push a token tree into a registered connector. */
export async function connectorPush(name, tree, ctx) {
  const c = getConnector(name);
  if (!c) throw new Error(`connector not found: ${name}`);
  return c.push(tree, ctx);
}
