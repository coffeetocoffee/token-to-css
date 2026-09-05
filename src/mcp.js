import {
  normalizeW3C,
  resolveReferences,
  getTransitiveDependents,
  createChangeRequest,
  parseColor,
  getByPath,
} from "@token-to-css/core";
import { lintConsumer } from "./adopt.js";

/**
 * Build an MCP context. `tokens` is the raw token tree; `serveUrl` (optional)
 * points at a running `token-to-css serve` instance so change requests opened via
 * MCP appear in `GET /change-requests`.
 */
export function createMcpContext({ tokens, serveUrl = null } = {}) {
  return { tokens, serveUrl, changeRequests: [] };
}

// --- v12.0: language tools for the VS Code extension -------------------
// The extension is a thin client over these: hover/completion/diagnostics all
// resolve server-side so no compiler code ships inside the editor bundle.

/** Flatten a resolved tree to `{ [dottedPath]: { path[], value, variable } }`. */
function flatResolved(tree) {
  const out = {};
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const p = [...prefix, key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value, p);
      } else if (value !== null && value !== undefined) {
        const dotted = p.join(".");
        out[dotted] = {
          path: p,
          value: String(value),
          variable: `--${p
            .map((s) =>
              String(s)
                .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
                .replace(/[\s_]+/g, "-")
                .toLowerCase()
            )
            .join("-")}`,
        };
      }
    }
  };
  walk(tree, []);
  return out;
}

function collectDeprecations(node, prefix = [], out = []) {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    if ("$value" in node) {
      if (node.deprecated) {
        out.push({ path: prefix.join("."), replacedBy: node.replacedBy || null });
      }
      return out;
    }
    for (const [k, v] of Object.entries(node)) collectDeprecations(v, [...prefix, k], out);
  }
  return out;
}

const DIMENSION_RE = /^\s*-?\d*\.?\d+(px|rem|em|%|pt|vh|vw|ch|ex|fr|vmin|vmax)\s*$/;

/**
 * Build the language index once per context: resolved flat tokens, valid
 * dotted paths, deprecations. Cheap enough to rebuild per call, cached on
 * the context until `ctx.tokens` is replaced.
 */
function languageIndex(ctx) {
  if (ctx._lang && ctx._langTokens === ctx.tokens) return ctx._lang;
  const resolved = resolveReferences(normalizeW3C(ctx.tokens), { reduce: true });
  const flat = flatResolved(resolved);
  const deprecations = collectDeprecations(ctx.tokens);
  // Raw-tree dotted paths (modes/brands subtrees included) for ref validation.
  const rawPaths = [];
  const walkRaw = (node, prefix) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      if ("$value" in node) {
        rawPaths.push(prefix.join("."));
        return;
      }
      for (const [k, v] of Object.entries(node)) walkRaw(v, [...prefix, k]);
    } else if (node !== null && node !== undefined) {
      rawPaths.push(prefix.join("."));
    }
  };
  walkRaw(ctx.tokens, []);
  ctx._lang = {
    flat,
    paths: Object.keys(flat).sort(),
    rawPaths: [...new Set(rawPaths)].sort(),
    deprecations,
  };
  ctx._langTokens = ctx.tokens;
  return ctx._lang;
}

function tokenInfoPayload(ctx, path) {
  const lang = languageIndex(ctx);
  const entry = lang.flat[path];
  if (!entry) {
    const raw = getByPath(ctx.tokens, path.split("."));
    if (raw === undefined) return null;
    const value =
      raw && typeof raw === "object" && !Array.isArray(raw) && "$value" in raw
        ? raw.$value
        : raw;
    return {
      path,
      value: String(value),
      variable: null,
      resolved: false,
      deprecated: false,
      replacedBy: null,
      dependents: [],
    };
  }
  const deprecation = lang.deprecations.find((d) => d.path === path) || null;
  const parsed = parseColor(entry.value) || null;
  return {
    path,
    value: entry.value,
    variable: entry.variable,
    resolved: true,
    color: parsed
      ? {
          hex: formatHex(parsed),
          swatch: true,
        }
      : null,
    kind:
      parsed || /^#|rgb\(|rgba\(|hsl\(|oklch\(|oklab\(|lab\(|lch\(/.test(entry.value)
        ? "color"
        : DIMENSION_RE.test(entry.value)
          ? "dimension"
          : "text",
    deprecated: Boolean(deprecation),
    replacedBy: deprecation ? deprecation.replacedBy : null,
    dependents: getTransitiveDependents(ctx.tokens, path),
  };
}

function formatHex({ r, g, b, a }) {
  const toHex = (n) => Math.round(n).toString(16).padStart(2, "0");
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return a >= 1 ? hex : `${hex}${toHex(a * 255)}`;
}

/** Completions for `--var` names (CSS) and `{dotted}` refs (token files). */
function completionsPayload(ctx, { prefix = "", kind = "css", max = 200 } = {}) {
  const lang = languageIndex(ctx);
  const p = String(prefix).toLowerCase();
  const out = [];
  for (const path of lang.paths) {
    const entry = lang.flat[path];
    const dep = lang.deprecations.find((d) => d.path === path);
    const label = kind === "ref" ? `{${path}}` : entry.variable;
    const low = label.toLowerCase();
    if (p && !low.includes(p) && !path.toLowerCase().includes(p)) continue;
    out.push({
      label,
      path,
      value: entry.value,
      variable: entry.variable,
      kind: dep ? "deprecated" : "token",
      deprecated: Boolean(dep),
      replacedBy: dep ? dep.replacedBy : null,
      detail: dep
        ? `deprecated — use ${dep.replacedBy || "a replacement"}`
        : entry.value,
    });
    if (out.length >= max) break;
  }
  return { completions: out, total: lang.paths.length };
}

/** Consumer-code diagnostics (v9 lint) + unknown `{ref}` diagnostics. */
function diagnosticsPayload(ctx, { sources = [], text = null, file = "untitled" } = {}) {
  const diagnostics = [];
  sources = sources.filter((s) => s && typeof s.text === "string");
  if (text != null) sources = [...sources, { file, text }];
  if (sources.length > 0) {
    const { findings } = lintConsumer(ctx.tokens, sources);
    for (const f of findings) {
      diagnostics.push({
        source: "token-to-css",
        file: f.file,
        line: f.line,
        column: f.column,
        index: f.index,
        length: f.value.length,
        severity: "warning",
        code: "hardcoded-value",
        message: `hardcoded ${f.kind} "${f.value}" — use var(${f.variable})`,
        value: f.value,
        variable: f.variable,
        path: f.path,
        exact: f.exact,
        quickFix: { title: `Use ${f.variable}`, variable: f.variable },
      });
    }
  }
  return { diagnostics, total: diagnostics.length };
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
  {
    name: "token_info",
    description:
      "v12 language tool: hover data for a token — resolved value, color swatch (hex), CSS variable, deprecation/replacedBy, and transitive dependents.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "completions",
    description:
      "v12 language tool: token completions. kind=\"css\" returns `--var` names for CSS/SCSS files; kind=\"ref\" returns `{dotted}` refs for token files. Filtered by `prefix`.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string" },
        kind: { type: "string", enum: ["css", "ref"] },
        max: { type: "number" },
      },
    },
  },
  {
    name: "diagnostics",
    description:
      "v12 language tool: consumer-code diagnostics — hardcoded color/dimension literals that match (or nearly match, OKLCH) a known token, with a `use var(--token)` quick-fix.",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: { file: { type: "string" }, text: { type: "string" } },
          },
        },
        text: { type: "string" },
        file: { type: "string" },
      },
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
  if (name === "token_info") {
    if (!args.path) throw new Error("token_info requires a 'path' argument");
    const info = tokenInfoPayload(ctx, args.path);
    if (!info) throw new Error(`unknown token: ${args.path}`);
    return info;
  }
  if (name === "completions") {
    return completionsPayload(ctx, args);
  }
  if (name === "diagnostics") {
    return diagnosticsPayload(ctx, args);
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
        serverInfo: { name: "token-to-css", version: "12.0.0" },
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
