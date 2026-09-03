import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, watch } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  normalizeW3C,
  resolveReferences,
  convert,
  reverse,
  buildNameRegistry,
} from "./index.js";
import { applyReversedIntoSource } from "./sync.js";
import { deepMerge } from "./merge.js";
import { buildClientJS } from "./client.js";
import { buildExplorerHTML } from "./docs.js";
import { createChangeRequest, approveChangeRequest, rejectChangeRequest, applyChangeRequest } from "./governance.js";

function readJSON(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Resolve a token tree (optionally applying a mode/brand override). */
export function resolveTree(raw, { mode, brand } = {}) {
  const tree = normalizeW3C(raw);
  const modeKey = tree.modes ? "modes" : tree.themes ? "themes" : null;
  const brandKey = tree.brands ? "brands" : tree.brand ? "brand" : null;
  let base = tree;
  if (modeKey) {
    base = structuredClone(base);
    delete base[modeKey];
  }
  if (brandKey) {
    base = structuredClone(base);
    delete base[brandKey];
  }
  const merged = structuredClone(base);
  if (modeKey && mode && tree[modeKey][mode]) deepMerge(merged, tree[modeKey][mode]);
  if (brandKey && brand && tree[brandKey][brand]) deepMerge(merged, tree[brandKey][brand]);
  return resolveReferences(merged, { reduce: true });
}

function getByPath(node, path) {
  let cur = node;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function buildPlaygroundHTML(tree, options = {}) {
  const modes = Object.keys(tree.modes || tree.themes || {});
  const brands = Object.keys(tree.brands || tree.brand || {});
  const modeOpts = modes
    .map((m) => `<option value="${m}">${m}</option>`)
    .join("");
  const brandOpts = brands
    .map((b) => `<option value="${b}">${b}</option>`)
    .join("");
  const css = convert(tree, { format: "css" });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>token-to-css — live playground</title>
<style>
${css}
body{font-family:system-ui,sans-serif;margin:2rem;background:var(--color-background,white);color:var(--color-text,#111)}
.toolbar{display:flex;gap:1rem;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap}
.token{padding:.4rem 0;border-bottom:1px solid #eee;display:flex;gap:.75rem;align-items:center}
.sw{width:2rem;height:2rem;border-radius:.375rem;border:1px solid #ccc}
code{background:#f4f4f5;padding:.1rem .4rem;border-radius:.25rem}
</style>
</head>
<body>
<h1>Live design-system playground</h1>
<div class="toolbar">
<label>mode <select id="mode"><option value="">(default)</option>${modeOpts}</select></label>
<label>brand <select id="brand"><option value="">(default)</option>${brandOpts}</select></label>
<button id="propose">Propose change to primary</button>
</div>
<div id="tokens"></div>
<script>
const client = TokenClient({ streamUrl: "/events" });
function render(tree){
  const rows = Object.entries(tree).filter(([k,v])=>typeof v==="string").map(([k,v])=>
    '<div class="token"><span class="sw" style="background:var(--'+k.replace(/\\./g,"-")+')"></span><code>'+k+'</code><code>'+v+'</code></div>'
  ).join("");
  document.getElementById("tokens").innerHTML = rows;
}
client.on(render);
fetch("/tokens").then(r=>r.json()).then(render);
document.getElementById("mode").addEventListener("change",e=>client.setMode(e.target.value));
document.getElementById("brand").addEventListener("change",e=>client.setBrand(e.target.value));
document.getElementById("propose").addEventListener("click",async ()=>{
  const tree = client.snapshot() || {};
  const cur = (tree.color && tree.color.primary) || "#3b82f6";
  const next = prompt("New value for color.primary", cur);
  if(!next) return;
  const proposal = { color: { primary: next } };
  await fetch("/tokens",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(proposal)});
});
</script>
</body>
</html>
`;
}

/**
 * Create a live token server — the v5.0 "Token Server" mesh.
 *
 * - `GET /tokens[?mode=&brand=]` returns the resolved tree as JSON.
 * - `GET /tokens/<dotted.path>` returns a single resolved value (or 404).
 * - `GET /tokens.names.json` returns the canonical name registry (if enabled).
 * - `GET /events` is an SSE stream that pushes `{ tree }` on every change.
 * - `POST /tokens` (write scope) folds a submitted tree into `tokens.json` via
 *   `applyReversedIntoSource` and re-broadcasts to all subscribers. Idempotent:
 *   a no-op submission does not re-trigger a write loop.
 * - `GET /` serves the explorer or, with `playground`, the live playground.
 * - `GET /tokens-client.js` serves the generated client SDK.
 *
 * Auth / scoping (v6.0): pass `options.auth` as a `{ token: "read" | "write" }`
 * map or a resolver `(token) => "read" | "write" | null`. When auth is enabled,
 * every request needs a `Authorization: Bearer <token>` header; `GET` accepts
 * read or write scope, `POST /tokens` requires write scope (a read-only token is
 * rejected with 403 and the source file is never mutated). With no `auth`, the
 * server is open (legacy behavior).
 *
 * Returns the `http.Server` with `.broadcast(event)` and `.setTokens(tree)`
 * helpers so connectors (e.g. the Figma connector) can push into the mesh.
 */
export function createTokenServer(options = {}) {
  const tokensPath = options.tokensPath ? resolvePath(options.tokensPath) : null;
  const auth = options.auth || null;
  const useRegistry = Boolean(options.registry);
  const approvalMode = Boolean(options.approve);
  let sourceTree = options.tokens ? structuredClone(options.tokens) : null;
  if (tokensPath && sourceTree == null) sourceTree = readJSON(tokensPath);
  let registry = useRegistry ? buildNameRegistry(sourceTree) : null;
  let clientJs = buildClientJS({ streamUrl: options.streamUrl || "/events" });

  const clients = new Set();
  const teamClients = new Map();
  const changeRequests = [];
  let watcher = null;

  function snapshotTree() {
    return resolveTree(sourceTree);
  }

  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
    for (const [team, set] of teamClients) {
      for (const res of set) {
        try {
          res.write(payload);
        } catch {
          set.delete(res);
        }
      }
    }
  }

  function pushUpdate() {
    if (registry) registry = buildNameRegistry(sourceTree);
    broadcast({ type: "update", tree: snapshotTree() });
  }

  function loadFromDisk() {
    if (!tokensPath) return;
    try {
      sourceTree = readJSON(tokensPath);
      pushUpdate();
    } catch {
      /* ignore unreadable edits */
    }
  }

  function setTokens(tree) {
    sourceTree = tree;
    if (registry) registry = buildNameRegistry(sourceTree);
    pushUpdate();
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const q = url.searchParams;

    // Auth / scoping gate (v6.0). Open server when no `auth` configured.
    if (auth) {
      const header = req.headers["authorization"] || "";
      const m = /^Bearer\s+(.+)$/i.exec(header);
      const token = m ? m[1].trim() : null;
      const scope = token ? (typeof auth === "function" ? auth(token) : auth[token] || null) : null;
      if (!scope) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized: missing or invalid bearer token");
        return;
      }
      if (req.method === "POST" && scope !== "write") {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden: write scope required");
        return;
      }
    }

    if (req.method === "GET" && path === "/tokens-client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(clientJs);
      return;
    }

    if (req.method === "GET" && path === "/tokens.names.json" && registry) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(registry.toJSON(), null, 2));
      return;
    }

    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "snapshot", tree: snapshotTree() })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && path === "/tokens") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const incoming = JSON.parse(body);

          if (approvalMode) {
            const cr = createChangeRequest(sourceTree, incoming, { author: "api" });
            changeRequests.push(cr);
            broadcast({ type: "change-request", cr: { id: cr.id, status: cr.status } });
            res.writeHead(202, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, pending: true, cr: { id: cr.id, status: cr.status } }));
            return;
          }

          if (!tokensPath) {
            const { source, changed } = applyReversedIntoSource(sourceTree, incoming);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, source: "in-memory", changed: changed.length }));
            setTokens(source);
            return;
          }
          const { source, changed, skipped } = applyReversedIntoSource(sourceTree, incoming);
          if (changed.length === 0 && skipped.length === 0) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, changed: 0 }));
            return;
          }
          writeFileSync(tokensPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
          sourceTree = source;
          if (registry) registry = buildNameRegistry(sourceTree);
          pushUpdate();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, changed: changed.length, skipped: skipped.length }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === "GET" && path.startsWith("/tokens")) {
      const sub = path.slice("/tokens".length).replace(/^\//, "");
      if (sub === "" || sub === "/") {
        const tree = snapshotTree();
        const mode = q.get("mode") || undefined;
        const brand = q.get("brand") || undefined;
        const out = mode || brand ? resolveTree(sourceTree, { mode, brand }) : tree;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out, null, 2));
        return;
      }
      const value = getByPath(snapshotTree(), sub.split("."));
      if (value === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found", path: sub }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ path: sub, value }));
      return;
    }

    if (req.method === "GET" && (path === "/" || path === "")) {
      const html = options.playground
        ? buildPlaygroundHTML(sourceTree, options)
        : buildExplorerHTML(sourceTree, { ...options, files: [] });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // Change-request endpoints (v7.0)
    if (req.method === "GET" && path === "/change-requests") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(changeRequests, null, 2));
      return;
    }

    if (req.method === "POST" && path.startsWith("/change-requests/") && path.endsWith("/approve")) {
      const crId = path.split("/")[2];
      const cr = changeRequests.find((c) => c.id === crId);
      if (!cr) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "change request not found" }));
        return;
      }
      try {
        approveChangeRequest(cr);
        if (tokensPath) {
          const { tree } = applyChangeRequest(sourceTree, cr);
          writeFileSync(tokensPath, `${JSON.stringify(tree, null, 2)}\n`, "utf8");
          sourceTree = tree;
          pushUpdate();
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, cr }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && path.startsWith("/change-requests/") && path.endsWith("/reject")) {
      const crId = path.split("/")[2];
      const cr = changeRequests.find((c) => c.id === crId);
      if (!cr) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "change request not found" }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { reason } = body ? JSON.parse(body) : {};
          rejectChangeRequest(cr, reason);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, cr }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // Team-scoped endpoints (v7.0)
    if (path.startsWith("/teams/")) {
      const parts = path.split("/");
      const team = parts[2];
      const sub = parts.slice(3).join("/");

      if (req.method === "GET" && (sub === "tokens" || sub === "")) {
        const tree = snapshotTree();
        const teamKey = tree.teams ? tree.teams[team] : null;
        if (!teamKey) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `team "${team}" not found` }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(teamKey, null, 2));
        return;
      }

      if (req.method === "GET" && sub === "events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "snapshot", team, tree: snapshotTree().teams?.[team] })}\n\n`);
        if (!teamClients.has(team)) teamClients.set(team, new Set());
        teamClients.get(team).add(res);
        req.on("close", () => {
          const set = teamClients.get(team);
          if (set) set.delete(res);
        });
        return;
      }

      if (req.method === "POST" && sub === "tokens") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const incoming = JSON.parse(body);
            if (!sourceTree.teams) sourceTree.teams = {};
            if (!sourceTree.teams[team]) sourceTree.teams[team] = {};
            deepMerge(sourceTree.teams[team], incoming);
            if (tokensPath) {
              writeFileSync(tokensPath, `${JSON.stringify(sourceTree, null, 2)}\n`, "utf8");
            }
            pushUpdate();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, team }));
          } catch (err) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if (req.method === "GET" && sub === "") {
        if (!sourceTree.teams) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "no teams defined" }));
          return;
        }
        const teams = Object.keys(sourceTree.teams);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ teams }, null, 2));
        return;
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  if (options.watch !== false && tokensPath && existsSync(tokensPath)) {
    try {
      watcher = watch(tokensPath, { persistent: false }, () => loadFromDisk());
    } catch {
      watcher = null;
    }
  }

  server.broadcast = broadcast;
  server.setTokens = setTokens;
  server.snapshotTree = snapshotTree;
  server.changeRequests = changeRequests;
  server.closeAll = () => {
    if (watcher) watcher.close();
    for (const c of clients) c.end();
    for (const [, set] of teamClients) {
      for (const c of set) c.end();
    }
    clients.clear();
    teamClients.clear();
  };
  return server;
}
