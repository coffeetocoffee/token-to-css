/**
 * v11.0 Server-to-server relay — the federated mesh.
 *
 * Multiple `serve` instances (one per org) link into a mesh: SSE events relay
 * between them, but **each org's source stays authoritative**. A remote change
 * arrives as a *change-request* (v7 approval flow), never a direct write —
 * `applyReversedIntoSource` only ever runs against local source by local
 * policy, when the CR is approved.
 */

import { createChangeRequest } from "@token-to-css/core";

function deepEqualJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

/**
 * Register the relay receive-route machinery on a token server: `POST /relay`
 * accepts `{ origin, tree }` and creates a *pending* change-request tagged
 * with the remote org — it never writes the source directly. Returns the
 * handler used by `createTokenServer` (exported for standalone use).
 */
export function handleRelayPost(serverState, origin, tree) {
  const { sourceTree, changeRequests, broadcast } = serverState;
  // Idempotence: a re-broadcast of a tree we already have does not open a CR.
  if (deepEqualJSON(sourceTree, tree)) {
    return { ok: true, noop: true };
  }
  // Nor does a duplicate of an already-pending remote proposal.
  const jsonTree = JSON.stringify(tree);
  const duplicate = changeRequests.some(
    (cr) => cr.status === "pending" && JSON.stringify(cr.proposed) === jsonTree
  );
  if (duplicate) {
    return { ok: true, noop: true, duplicate: true };
  }
  const cr = createChangeRequest(sourceTree, tree, {
    author: `relay:${origin || "unknown-org"}`,
    reason: "cross-org relay",
  });
  cr.origin = origin || null;
  changeRequests.push(cr);
  broadcast({
    type: "change-request",
    channel: "stable",
    cr: { id: cr.id, status: cr.status, author: cr.author, origin: cr.origin },
  });
  return { ok: true, pending: true, cr: { id: cr.id, status: cr.status, origin: cr.origin } };
}

/**
 * One-shot relay: pull org A's resolved tree and hand it to org B as a
 * pending change-request. The remote tree is never applied directly —
 * org B's local policy (approve/reject) decides.
 */
export async function relayChange({
  fromUrl,
  toUrl,
  token = null,
  origin = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const res = await fetchImpl(`${fromUrl}/tokens`);
  if (!res.ok) throw new Error(`relay: fetching ${fromUrl}/tokens failed (${res.status})`);
  const tree = await res.json();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r2 = await fetchImpl(`${toUrl}/relay`, {
    method: "POST",
    headers,
    body: JSON.stringify({ origin: origin || fromUrl, tree }),
  });
  const body = await r2.json().catch(() => ({}));
  return { status: r2.status, ...body };
}

/**
 * Minimal SSE consumer over fetch (zero-dep, works on Node 20+).
 * Calls `onEvent(parsed)` for every `data:` frame; returns `{ stop() }`.
 */
export function consumeSSE(url, onEvent, { signal = null, fetchImpl = globalThis.fetch } = {}) {
  const controller = signal ? null : new AbortController();
  const sig = signal || controller.signal;
  (async () => {
    const res = await fetchImpl(url, { signal: sig });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* malformed frame — skip */
        }
      }
    }
  })().catch(() => {
    /* connection closed or failed — the relay stops silently */
  });
  return { stop: () => controller && controller.abort() };
}

/**
 * Attach a live relay watcher: subscribe to every peer's `/events` SSE stream
 * and forward peer `update` trees into this server's `POST /relay` (where they
 * become pending change-requests). Skips events whose tree equals this
 * server's current tree, so an approved CR re-broadcast cannot loop.
 *
 * Returns `{ stop() }`.
 */
export function attachOrgRelay({
  selfUrl,
  peerUrls,
  token = null,
  origin = null,
  fetchImpl = globalThis.fetch,
  getCurrentTree = null,
} = {}) {
  const stops = [];
  for (const peerUrl of peerUrls) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const stop = consumeSSE(
      `${peerUrl}/events`,
      async (event) => {
        if (event.type !== "update" || !event.tree) return;
        try {
          const current = getCurrentTree ? getCurrentTree() : null;
          if (current && deepEqualJSON(current, event.tree)) return;
          const r = await fetchImpl(`${selfUrl}/relay`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ origin: origin || peerUrl, tree: event.tree }),
          });
          await r.json().catch(() => {});
        } catch {
          /* relay errors are non-fatal */
        }
      },
      { fetchImpl }
    );
    stops.push(stop);
  }
  return { stop: () => stops.forEach((s) => s.stop()) };
}
