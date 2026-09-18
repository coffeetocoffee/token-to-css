import {
  normalizeW3C,
  resolveReferences,
  getTransitiveDependents,
  createChangeRequest,
  parseColor,
  getByPath,
  generateCodemod,
} from "@token-to-css/core";
import { lintConsumer } from "./adopt.js";
import { previewEdit, previewBatchEdit, buildEditCommit } from "./editor.js";
import {
  suggestTokenName,
  groupTokens,
  searchTokens,
  explainToken,
} from "./ai.js";

/**
 * Build an MCP context. `tokens` is the raw token tree; `serveUrl` (optional)
 * points at a running `token-to-css serve` instance so change requests opened via
 * MCP appear in `GET /change-requests`.
 */
export function createMcpContext({ tokens, serveUrl = null } = {}) {
  return { tokens, serveUrl, changeRequests: [] };
}

// --- v12.0: language tools over MCP --------------------------------------
// Hover/completion/diagnostics resolve server-side for AI agents and editor
// integrations. No compiler code ships inside any client bundle.

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
const REF_SCAN_RE = /\{([\w.:-]+)\}/g;
const VAR_USE_SCAN_RE = /var\(\s*(--[\w-]+)\s*\)/g;

/** 1-based {line, column} for a 0-based offset (same convention as lintConsumer). */
function posOf(text, index) {
  return {
    line: text.slice(0, index).split("\n").length,
    column: index - text.lastIndexOf("\n", index - 1),
  };
}

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

/**
 * v12.3 — editor diagnostics over MCP:
 * - `hardcoded-value` (v9 lintConsumer) for consumer sources (CSS/SCSS/etc.);
 * - `deprecated-in-use` (v7 lint) for `var(--deprecated)` uses in consumer
 *   sources and `{deprecated.ref}` uses in token-file sources, each carrying
 *   the `replacedBy` migration and a quick-fix replacement.
 *
 * A source is a token file when it says so (`kind: "tokens"`) or its file name
 * ends in `.json`; everything else is consumer code.
 */
function diagnosticsPayload(ctx, { sources = [], text = null, file = "untitled" } = {}) {
  const diagnostics = [];
  sources = sources.filter((s) => s && typeof s.text === "string");
  if (text != null) sources = [...sources, { file, text }];
  if (sources.length === 0) return { diagnostics, total: 0 };

  const lang = languageIndex(ctx);
  const deprecated = new Map(lang.deprecations.map((d) => [d.path, d.replacedBy]));
  const pathByVariable = {};
  for (const [path, entry] of Object.entries(lang.flat)) pathByVariable[entry.variable] = path;

  for (const s of sources) {
    const kind = s.kind || (/\.json$/i.test(String(s.file || "")) ? "tokens" : "consumer");
    if (kind === "tokens") {
      REF_SCAN_RE.lastIndex = 0;
      let m;
      while ((m = REF_SCAN_RE.exec(s.text))) {
        const ref = m[1];
        if (Number.isInteger(Number(ref))) continue;
        const replacedBy = deprecated.get(ref);
        if (replacedBy === undefined) continue;
        const start = m.index + 1; // the ref inside the braces
        const { line, column } = posOf(s.text, start);
        diagnostics.push({
          source: "token-to-css",
          file: s.file,
          line,
          column,
          index: start,
          length: ref.length,
          severity: "warning",
          code: "deprecated-in-use",
          message: `{${ref}} is deprecated${replacedBy ? ` — use {${replacedBy}} instead` : ""}`,
          value: ref,
          path: ref,
          exact: true,
          replacedBy,
          quickFix: replacedBy
            ? { title: `Use {${replacedBy}}`, replacement: replacedBy }
            : null,
        });
      }
      continue;
    }
    const { findings } = lintConsumer(ctx.tokens, [s]);
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
        quickFix: { title: `Use ${f.variable}`, replacement: `var(${f.variable})`, variable: f.variable },
      });
    }
    VAR_USE_SCAN_RE.lastIndex = 0;
    let v;
    while ((v = VAR_USE_SCAN_RE.exec(s.text))) {
      const name = v[1];
      const path = pathByVariable[name];
      if (!path) continue;
      const replacedBy = deprecated.get(path);
      if (replacedBy === undefined) continue;
      const replacementVariable = lang.flat[replacedBy] ? lang.flat[replacedBy].variable : null;
      if (!replacementVariable) continue;
      const start = v.index + v[0].indexOf(name);
      const { line, column } = posOf(s.text, start);
      diagnostics.push({
        source: "token-to-css",
        file: s.file,
        line,
        column,
        index: start,
        length: name.length,
        severity: "warning",
        code: "deprecated-in-use",
        message: `var(${name}) is deprecated — use var(${replacementVariable})`,
        value: name,
        path,
        exact: true,
        replacedBy,
        variable: replacementVariable,
        quickFix: { title: `Use var(${replacementVariable})`, replacement: replacementVariable },
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
      "v12 language tool: consumer-code diagnostics — hardcoded color/dimension literals that match (or nearly match, OKLCH) a known token, plus v7 `deprecated-in-use` squiggles for var(--deprecated) uses (consumer sources) and {deprecated.ref} uses (token-file sources), each with a replacement quick-fix. Sources ending in .json are treated as token files unless `kind: \"consumer\"` is set.",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              text: { type: "string" },
              kind: { type: "string", enum: ["tokens", "consumer"] },
            },
          },
        },
        text: { type: "string" },
        file: { type: "string" },
      },
    },
  },
  {
    name: "create_batch_change_request",
    description:
      "v15: open ONE change request for a multi-token proposal (e.g. a palette shift) — every edit reviewed as a single unit and classified once by the semver verdict. Each edit is { path, value, mode?, brand? } or { rename: { from, to } }; edits apply in sequence (a later edit may reference a token an earlier edit added). With a serve URL the whole proposed tree lands as one pending CR (202 under --approve).",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              value: {},
              mode: { type: "string" },
              brand: { type: "string" },
              rename: {
                type: "object",
                properties: { from: { type: "string" }, to: { type: "string" } },
              },
              confirmed: { type: "boolean" },
            },
          },
        },
        reason: { type: "string" },
        author: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["edits"],
    },
  },
  {
    name: "create_migration_request",
    description:
      "v15: propose a rename as a governed migration — the change request carries the ready-to-run v7 codemod (rename + update-ref operations) so consumers migrate alongside the token file. Governance gates the merge: the rename lands as one pending CR when a serve URL runs --approve.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        reason: { type: "string" },
        author: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "suggest_name",
    description:
      "v15 sampling tool: suggest a token name the linter and the name registry would accept — kebab-clean, under the right group, collisions disambiguated with the registry -N rule. Pass `path` to rename an existing token, or `value` (+ optional `group`/`label`) to name a new one.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        value: {},
        group: { type: "string" },
        label: { type: "string" },
      },
    },
  },
  {
    name: "group_tokens",
    description:
      "v15 sampling tool: propose moving tokens under a common parent (a grouping) — returns the rename operations, the resulting tree, and one v7 codemod that rewrites every reference. Pass `paths` (+ `into`), or omit both to use a `by` heuristic (value/kind/prefix) over the tree. A proposal only — nothing moves until it becomes a migration request.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        into: { type: "string" },
        by: { type: "string", enum: ["value", "kind", "prefix"] },
      },
    },
  },
  {
    name: "search",
    description:
      "v15: lexical search over the token tree (zero-dep). Terms match path segments, the variable name, kind, and value; tokens matching every term rank first. Use before edits to find candidates.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, max: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "explain",
    description:
      "v15 provenance tool: everything about one token — raw and resolved value, kind + color hex, the references it consumes, its direct/transitive dependents (blast radius), deprecation + replacedBy, per-mode/brand overrides, and its $version. Unknown path → error.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
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
  // --- v15: AI-native token ops -------------------------------------------
  if (name === "create_batch_change_request") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0)
      throw new Error("create_batch_change_request requires a non-empty 'edits' array");
    const preview = previewBatchEdit(ctx.tokens, edits, { confirmed: args.confirmed });
    if (!preview.ok) return { ok: false, errors: preview.errors };
    if (ctx.serveUrl) {
      const base = ctx.serveUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preview.proposed),
      });
      const json = await res.json();
      return {
        ok: true,
        id: json.cr ? json.cr.id : null,
        status: json.cr ? json.cr.status : json.pending ? "pending" : "applied",
        pending: Boolean(json.pending || json.cr),
        edits: preview.edits,
        verdict: preview.verdict,
        diff: preview.diff,
        codemods: preview.codemods,
      };
    }
    const cr = createChangeRequest(ctx.tokens, preview.proposed, {
      author: args.author,
      reason: args.reason,
    });
    cr.batch = {
      edits: preview.edits,
      verdict: preview.verdict,
      impact: preview.impact,
      codemods: preview.codemods,
    };
    ctx.changeRequests.push(cr);
    return {
      ok: true,
      id: cr.id,
      status: cr.status,
      edits: preview.edits,
      verdict: preview.verdict,
      diff: preview.diff,
      impact: preview.impact,
      codemods: preview.codemods,
    };
  }
  if (name === "create_migration_request") {
    if (!args.from || !args.to)
      throw new Error("create_migration_request requires 'from' and 'to'");
    const preview = previewEdit(ctx.tokens, {
      rename: { from: args.from, to: args.to },
      confirmed: args.confirmed,
    });
    const codemod = generateCodemod(ctx.tokens, { from: args.from, to: args.to });
    if (!preview.ok) {
      return { ok: false, errors: preview.errors, codemod };
    }
    if (ctx.serveUrl) {
      // Governance gates the merge: the folded tree lands as one pending CR;
      // the codemod rides along for the consumer side.
      const base = ctx.serveUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preview.proposed),
      });
      const json = await res.json();
      return {
        ok: true,
        id: json.cr ? json.cr.id : null,
        status: json.cr ? json.cr.status : json.pending ? "pending" : "applied",
        pending: Boolean(json.pending || json.cr),
        from: args.from,
        to: args.to,
        codemod,
        impact: preview.impact,
        verdict: preview.verdict,
        blocked: preview.blocked,
      };
    }
    const proposed = buildEditCommit(ctx.tokens, {
      rename: { from: args.from, to: args.to },
    }).source;
    const cr = createChangeRequest(ctx.tokens, proposed, {
      author: args.author,
      reason: args.reason || `migrate ${args.from} -> ${args.to}`,
    });
    cr.migration = { from: args.from, to: args.to, codemod };
    ctx.changeRequests.push(cr);
    return {
      ok: true,
      id: cr.id,
      status: cr.status,
      from: args.from,
      to: args.to,
      codemod,
      impact: preview.impact,
      verdict: preview.verdict,
      blocked: preview.blocked,
    };
  }
  if (name === "suggest_name") {
    return suggestTokenName(ctx.tokens, args);
  }
  if (name === "group_tokens") {
    return groupTokens(ctx.tokens, args);
  }
  if (name === "search") {
    return searchTokens(ctx.tokens, args.query, { max: args.max });
  }
  if (name === "explain") {
    if (!args.path) throw new Error("explain requires a 'path' argument");
    const info = explainToken(ctx.tokens, args.path);
    if (!info) throw new Error(`unknown token: ${args.path}`);
    return info;
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
        serverInfo: { name: "token-to-css", version: "15.0.0" },
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
