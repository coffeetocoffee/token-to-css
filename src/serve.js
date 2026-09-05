import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, watch } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  normalizeW3C,
  resolveReferences,
  convert,
  reverse,
  buildNameRegistry,
  applyReversedIntoSource,
  deepMerge,
  buildClientJS,
  buildExplorerHTML,
  createChangeRequest,
  approveChangeRequest,
  rejectChangeRequest,
  applyChangeRequest,
} from "@token-to-css/core";
import { buildEditorHTML, previewEdit } from "./editor.js";
import { getConnector, listConnectors } from "@token-to-css/connectors";
import { handleRelayPost, relayChange } from "./relay.js";

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
  // v11.0 org trust: when `options.org` is set, auth resolvers are invoked as
  // `auth(token, org)` so org-scoped tokens only resolve for their own org.
  const selfOrg = options.org || null;
  const useRegistry = Boolean(options.registry);
  const approvalMode = Boolean(options.approve);
  let sourceTree = options.tokens ? structuredClone(options.tokens) : null;
  if (tokensPath && sourceTree == null) sourceTree = readJSON(tokensPath);
  let registry = useRegistry ? buildNameRegistry(sourceTree) : null;
  // v10.0 release channels: `canary` is a staging tree promoted to `stable`.
  const channelTrees = { stable: sourceTree };
  if (options.channels && options.channels.canary) {
    channelTrees.canary = options.channels.canary;
  }
  let clientJs = buildClientJS({ streamUrl: options.streamUrl || "/events" });

  const clients = new Set();
  const channelClients = new Map();
  const teamClients = new Map();
  const changeRequests = [];
  let watcher = null;

  function snapshotTree(channel) {
    const base =
      channel === "canary" && channelTrees.canary ? channelTrees.canary : sourceTree;
    return resolveTree(base);
  }

  function broadcastChannel(channel, event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    if (channel !== "canary") {
      for (const res of clients) {
        try {
          res.write(payload);
        } catch {
          clients.delete(res);
        }
      }
    }
    const set = channelClients.get(channel);
    if (set) {
      for (const res of set) {
        try {
          res.write(payload);
        } catch {
          set.delete(res);
        }
      }
    }
  }

  function pushUpdate(channel) {
    const ch = channel || "stable";
    if (registry && ch !== "canary") registry = buildNameRegistry(sourceTree);
    broadcastChannel(ch, { type: "update", channel: ch, tree: snapshotTree(ch) });
  }

  function loadFromDisk() {
    if (!tokensPath) return;
    try {
      sourceTree = readJSON(tokensPath);
      channelTrees.stable = sourceTree;
      pushUpdate("stable");
    } catch {
      /* ignore unreadable edits */
    }
  }

  function setTokens(tree) {
    sourceTree = tree;
    channelTrees.stable = sourceTree;
    if (registry) registry = buildNameRegistry(sourceTree);
    pushUpdate("stable");
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const q = url.searchParams;

    // Auth / scoping gate (v6.0). Open server when no `auth` configured.
    // v11.0: with `options.org` set, org-aware resolvers (`createOrgAuth`)
    // receive `(token, org)` so org rooms are enforced — a foreign org's
    // token resolves to null (401).
    if (auth) {
      const header = req.headers["authorization"] || "";
      const m = /^Bearer\s+(.+)$/i.exec(header);
      const token = m ? m[1].trim() : null;
      const scope = token
        ? typeof auth === "function"
          ? selfOrg && auth.orgAware
            ? auth(token, selfOrg)
            : auth(token)
          : auth[token] || null
        : null;
      // v11.0 org trust: a token that is valid for *some* org but not this
      // server's org is forbidden (403), not unauthorized (401) — org A's
      // write token can never mutate org B's source.
      if (!scope && selfOrg && typeof auth === "function" && auth.orgAware && token && auth(token)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end(`forbidden: token is not valid for org "${selfOrg}"`);
        return;
      }
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
      const channel = q.get("channel") || "stable";
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "snapshot", channel, tree: snapshotTree(channel) })}\n\n`);
      if (channel === "canary") {
        if (!channelClients.has("canary")) channelClients.set("canary", new Set());
        channelClients.get("canary").add(res);
      } else {
        clients.add(res);
      }
      req.on("close", () => {
        clients.delete(res);
        const set = channelClients.get(channel);
        if (set) set.delete(res);
      });
      return;
    }

    if (req.method === "POST" && path === "/tokens") {
      const channel = q.get("channel") || "stable";
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const incoming = JSON.parse(body);

          // Canary channel: fold the change into the staging tree only. The
          // source file is never touched until the change is promoted.
          if (channel === "canary" && channelTrees.canary) {
            const { source } = applyReversedIntoSource(channelTrees.canary, incoming);
            channelTrees.canary = source;
            broadcastChannel("canary", { type: "update", channel: "canary", tree: snapshotTree("canary") });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, channel: "canary" }));
            return;
          }

          if (approvalMode) {
            const cr = createChangeRequest(sourceTree, incoming, { author: "api" });
            changeRequests.push(cr);
            broadcastChannel("stable", { type: "change-request", channel: "stable", cr: { id: cr.id, status: cr.status } });
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
          channelTrees.stable = source;
          if (registry) registry = buildNameRegistry(sourceTree);
          pushUpdate("stable");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, changed: changed.length, skipped: skipped.length }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // Release channels (v10.0): list channels and promote canary -> stable.
    if (req.method === "GET" && path === "/channels") {
      const channels = ["stable"];
      if (channelTrees.canary) channels.push("canary");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ channels }, null, 2));
      return;
    }

    if (req.method === "POST" && path === "/promote") {
      if (!channelTrees.canary) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no canary channel to promote" }));
        return;
      }
      sourceTree = structuredClone(channelTrees.canary);
      channelTrees.stable = sourceTree;
      if (registry) registry = buildNameRegistry(sourceTree);
      if (tokensPath) writeFileSync(tokensPath, `${JSON.stringify(sourceTree, null, 2)}\n`, "utf8");
      pushUpdate("stable");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, promoted: "canary->stable" }));
      return;
    }

    if (req.method === "GET" && path.startsWith("/tokens")) {
      const channel = q.get("channel") || "stable";
      const sub = path.slice("/tokens".length).replace(/^\//, "");
      if (sub === "" || sub === "/") {
        const base = channel === "canary" && channelTrees.canary ? channelTrees.canary : sourceTree;
        const mode = q.get("mode") || undefined;
        const brand = q.get("brand") || undefined;
        const out = mode || brand ? resolveTree(base, { mode, brand }) : snapshotTree(channel);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out, null, 2));
        return;
      }
      const value = getByPath(snapshotTree(channel), sub.split("."));
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

    // Visual token editor (v10.5). `GET /editor` serves the editable explorer;
    // `POST /editor/preview` is the diff-before-commit dry-run (validation +
    // diff + semver verdict + impact + codemod). Commits reuse the existing
    // `POST /tokens` write scope — no new protocol.
    if (req.method === "GET" && path === "/editor") {
      if (options.editor === false) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const html = buildEditorHTML(sourceTree, {
        canary: Boolean(channelTrees.canary),
        auth: Boolean(auth),
        editable: auth ? undefined : true,
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && path === "/editor/preview") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const edit = body ? JSON.parse(body) : {};
          const result = previewEdit(sourceTree, edit);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result, null, 2));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, errors: [{ code: "bad-request", message: err.message }] }));
        }
      });
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
        const { tree } = applyChangeRequest(sourceTree, cr);
        if (tokensPath) {
          writeFileSync(tokensPath, `${JSON.stringify(tree, null, 2)}\n`, "utf8");
        }
        sourceTree = tree;
        channelTrees.stable = sourceTree;
        if (registry) registry = buildNameRegistry(sourceTree);
        pushUpdate();
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

    // Cross-org relay (v11.0): a peer org's serve instance POSTs its tree
    // here; it lands as a *pending change-request* tagged with the remote
    // org — never a direct write. Applying it requires the v7 approve flow
    // (POST /change-requests/:id/approve), so local source stays
    // authoritative. Idempotent: a re-broadcast of an identical tree is a
    // no-op and does not open a CR.
    if (req.method === "POST" && path === "/relay") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { origin, tree } = JSON.parse(body);
          if (!tree || typeof tree !== "object") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "relay body must be { origin, tree }" }));
            return;
          }
          const result = handleRelayPost(
            {
              sourceTree,
              changeRequests,
              broadcast: (event) => broadcastChannel(event.channel || "stable", event),
            },
            origin,
            tree
          );
          res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
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

    // Connector Hub endpoints (v8.0). A connector registered via
    // `registerConnector` round-trips a token change through the mesh with zero
    // core changes: `GET /connectors` lists them, `POST /connectors/<name>/pull`
    // pulls the external tree into the mesh, `POST /connectors/<name>/push`
    // pushes the current mesh tree out. Both mutating routes already pass the
    // POST write-scope gate above when auth is enabled.
    if (req.method === "GET" && path === "/connectors") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ connectors: listConnectors() }, null, 2));
      return;
    }

    if (req.method === "POST" && path.startsWith("/connectors/")) {
      const m = /^\/connectors\/([^/]+)\/(pull|push)$/.exec(path);
      if (!m) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "expected /connectors/<name>/{pull|push}" }));
        return;
      }
      const name = m[1];
      const op = m[2];
      const connector = getConnector(name);
      if (!connector) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `connector not found: ${name}` }));
        return;
      }
      if (op === "pull") {
        connector
          .pull()
          .then((tree) => {
            setTokens(tree);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, connectors: [name] }));
          })
          .catch((err) => {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        return;
      }
      // push
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let tree = snapshotTree();
        if (body) {
          try {
            tree = JSON.parse(body);
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
            return;
          }
        }
        connector
          .push(tree)
          .then((result) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, connectors: [name], result }));
          })
          .catch((err) => {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
      });
      return;
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

  server.broadcast = (event) => broadcastChannel(event && event.channel ? event.channel : "stable", event);
  server.setTokens = setTokens;
  server.snapshotTree = snapshotTree;
  server.changeRequests = changeRequests;
  // v11.0 org identity + helpers for the relay mesh.
  server.org = selfOrg;
  server.getSourceTree = () => sourceTree;
  server.relay = (peerUrl, { token = null, fetchImpl = globalThis.fetch } = {}) =>
    relayChange({
      fromUrl: peerUrl,
      toUrl: `http://localhost:${options.port || 4173}`,
      token,
      origin: peerUrl,
      fetchImpl,
    });
  server.closeAll = () => {
    if (watcher) watcher.close();
    for (const c of clients) c.end();
    for (const [, set] of channelClients) {
      for (const c of set) c.end();
    }
    for (const [, set] of teamClients) {
      for (const c of set) c.end();
    }
    clients.clear();
    channelClients.clear();
    teamClients.clear();
  };
  return server;
}
