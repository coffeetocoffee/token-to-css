import { normalizeW3C, resolveReferences, getTransitiveDependents, createChangeRequest } from "./index.js";

/**
 * Build an MCP context. `tokens` is the raw token tree; `serveUrl` (optional)
 * points at a running `token-to-css serve` instance so change requests opened via
 * MCP appear in `GET /change-requests`.
 */
export function createMcpContext({ tokens, serveUrl = null } = {}) {
  return { tokens, serveUrl, changeRequests: [] };
}

const TOOLS = [
  {
    name: "list_tokens",
    description: "List all resolved design tokens (path -> value).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "impact",
    description:
      "Return the transitive dependents (blast radius) of a token, given its dotted path. Used before a rename.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "create_change_request",
    description:
      "Open a change request for a token mutation. When a serve URL is configured it appears in GET /change-requests.",
    inputSchema: {
      type: "object",
      properties: {
        proposed: { type: "object" },
        current: { type: "object" },
        reason: { type: "string" },
        author: { type: "string" },
      },
      required: ["proposed"],
    },
  },
];

async function callTool(name, args, ctx) {
  if (name === "list_tokens") {
    return resolveReferences(normalizeW3C(ctx.tokens), { reduce: true });
  }
  if (name === "impact") {
    if (!args.path) throw new Error("impact requires a 'path' argument");
    return {
      path: args.path,
      dependents: getTransitiveDependents(ctx.tokens, args.path),
    };
  }
  if (name === "create_change_request") {
    if (!args.proposed) throw new Error("create_change_request requires 'proposed'");
    if (ctx.serveUrl) {
      const base = ctx.serveUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args.proposed),
      });
      const json = await res.json();
      return {
        id: json.cr ? json.cr.id : null,
        status: json.cr ? json.cr.status : json.pending ? "pending" : "unknown",
        pending: Boolean(json.pending),
      };
    }
    const cr = createChangeRequest(args.current || ctx.tokens, args.proposed, {
      author: args.author,
      reason: args.reason,
    });
    ctx.changeRequests.push(cr);
    return { id: cr.id, status: cr.status };
  }
  throw new Error(`unknown tool: ${name}`);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handle a single JSON-RPC 2.0 message. Returns a response object, or `null` for
 * a notification that needs no reply.
 */
export function handleMcpMessage(message, ctx) {
  if (!message || typeof message !== "object")
    return rpcError(null, -32700, "Parse error");
  if (message.jsonrpc !== "2.0")
    return rpcError(message.id ?? null, -32600, "Invalid Request");
  const id = message.id ?? null;

  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "token-to-css", version: "9.0.0" },
      },
    };
  }
  if (message.method === "notifications/initialized" || message.method === "initialized")
    return null;
  if (message.method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params || {};
    return Promise.resolve()
      .then(() => callTool(name, args || {}, ctx))
      .then((result) => ({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      }))
      .catch((err) => rpcError(id, -32603, err.message));
  }
  return rpcError(id, -32601, `Method not found: ${message.method}`);
}
