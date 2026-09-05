import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { McpClient, resolveMcpCommand } from "../src/mcpClient.js";
import {
  findRefs,
  findVarUses,
  hoverAt,
  completionsAt,
  diagnosticsFor,
  quickFixFor,
} from "../src/providers.js";
import { buildLanguageIndex, tokenInfo } from "../src/language.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const CLI = join(REPO_ROOT, "src", "cli.js");
const FIXTURE = join(here, "fixtures", "tokens.json");

const TOKENS = {
  color: {
    primary: "#3b82f6",
    primaryHover: "#1d4ed8",
  },
  space: { md: "1rem" },
  modes: { dark: { color: { primary: "#93c5fd" } } },
  deprecated: { old: { $value: "#999", $type: "color", deprecated: true, replacedBy: "color.primary" } },
};

/** In-process MCP harness: spawns the real CLI (`mcp`) via McpClient. */
async function withMcp(fn) {
  const client = new McpClient({
    command: process.execPath,
    args: [CLI, "mcp", FIXTURE],
    cwd: REPO_ROOT,
  });
  try {
    await client.start();
    return await fn(client);
  } finally {
    client.dispose();
  }
}

test("mcp client: initialize handshake + tool list", async () => {
  await withMcp((client) => {
    assert.ok(client.serverInfo);
    assert.equal(client.serverInfo.name, "token-to-css");
    assert.ok(client.hasTool("list_tokens"));
    assert.ok(client.hasTool("token_info"));
    assert.ok(client.hasTool("completions"));
    assert.ok(client.hasTool("diagnostics"));
    assert.ok(client.hasTool("create_change_request"));
  });
});

test("mcp client: token_info resolves values, hex swatch, deprecation", async () => {
  await withMcp(async (client) => {
    const info = await client.callTool("token_info", { path: "color.primary" });
    assert.equal(info.path, "color.primary");
    assert.equal(info.value, "#3b82f6");
    assert.equal(info.variable, "--color-primary");
    assert.equal(info.color.hex, "#3b82f6");
    assert.equal(info.kind, "color");
    assert.equal(info.deprecated, false);

    const dep = await client.callTool("token_info", { path: "deprecated.old" });
    assert.equal(dep.deprecated, true);
    assert.equal(dep.replacedBy, "color.primary");

    const dim = await client.callTool("token_info", { path: "space.md" });
    assert.equal(dim.kind, "dimension");

    await assert.rejects(
      () => client.callTool("token_info", { path: "color.missing" }),
      /unknown token/
    );
  });
});

test("mcp client: completions (css + ref kinds, prefix filter)", async () => {
  await withMcp(async (client) => {
    const css = await client.callTool("completions", { kind: "css", prefix: "color-p" });
    const labels = css.completions.map((c) => c.label);
    assert.ok(labels.includes("--color-primary"));
    assert.ok(labels.includes("--color-primary-hover"));
    assert.ok(!labels.includes("--space-md"));

    const refs = await client.callTool("completions", { kind: "ref", prefix: "space" });
    assert.ok(refs.completions.some((c) => c.label === "{space.md}"));

    const all = await client.callTool("completions", {});
    assert.ok(all.completions.length >= 4);
    const dep = all.completions.find((c) => c.path === "deprecated.old");
    assert.equal(dep.deprecated, true);
    assert.equal(dep.replacedBy, "color.primary");
  });
});

test("mcp client: diagnostics returns hardcoded-value squiggles + quick-fix", async () => {
  await withMcp(async (client) => {
    const css = ".btn { color: #3b82f6; padding: 1rem; }";
    const payload = await client.callTool("diagnostics", {
      sources: [{ file: "a.css", text: css }],
    });
    const color = payload.diagnostics.find((d) => d.code === "hardcoded-value" && d.value === "#3b82f6");
    assert.ok(color, "hex finding expected");
    assert.equal(color.line, 1);
    assert.equal(color.variable, "--color-primary");
    assert.equal(color.exact, true);
    assert.equal(color.quickFix.variable, "--color-primary");
    const dim = payload.diagnostics.find((d) => d.value === "1rem");
    assert.ok(dim, "dimension finding expected");
  });
});

test("providers: findVarUses/findRefs offsets", () => {
  const text = ".a{color:var(--color-primary)} .b{content:{color.primary}}";
  const vars = findVarUses(text);
  assert.equal(vars.length, 1);
  assert.equal(text.substr(vars[0].index, vars[0].length), "var(--color-primary)");
  const refs = findRefs(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, "color.primary");
});

test("providers: hover on var(--x), {ref}, and matching hex", () => {
  const index = {
    byPath: {
      "color.primary": { path: "color.primary", value: "#3b82f6", variable: "--color-primary", deprecated: false },
    },
    byVariable: { "--color-primary": { path: "color.primary", value: "#3b82f6", variable: "--color-primary" } },
    byHex: { "#3b82f6": { path: "color.primary", value: "#3b82f6", variable: "--color-primary" } },
    completions: [],
  };
  const cssText = ".a{color:var(--color-primary)}";
  const nameStart = cssText.indexOf("--color-primary");
  const h1 = hoverAt(cssText, nameStart + 2, index);
  assert.equal(h1.path, "color.primary");
  assert.match(h1.markdown, /color\.primary/);

  const jsonText = '"x": "{color.primary}"';
  const refStart = jsonText.indexOf("{color.primary}");
  const h2 = hoverAt(jsonText, refStart + 2, index);
  assert.equal(h2.path, "color.primary");

  const hexText = ".a{color:#3b82F6}";
  const h3 = hoverAt(hexText, hexText.indexOf("#3b82F6") + 1, index);
  assert.equal(h3.kind, "suggestion");
  assert.match(h3.markdown, /var\(--color-primary\)/);

  assert.equal(hoverAt(cssText, 0, index), null);
});

test("providers: completionsAt css + ref contexts with replace ranges", () => {
  const index = {
    byPath: {},
    byVariable: {},
    byHex: {},
    completions: [
      { label: "--color-primary", path: "color.primary", value: "#3b82f6", variable: "--color-primary", deprecated: false },
      { label: "--space-md", path: "space.md", value: "1rem", variable: "--space-md", deprecated: false },
    ],
  };
  const css = ".a{color:var(--color-p)}";
  const offEnd = css.indexOf("p)}") + 1; // cursor right after "--color-p"
  const r1 = completionsAt(css, offEnd, index);
  assert.equal(r1.kind, "css");
  assert.equal(css.slice(r1.replaceStart, r1.replaceEnd), "--color-p");
  assert.ok(r1.items.some((i) => i.label === "--color-primary"));
  void offEnd;

  const json = '"x": "{color.';
  const r2 = completionsAt(json, json.length, index);
  assert.equal(r2.kind, "ref");
  assert.equal(json.slice(r2.replaceStart, r2.replaceEnd), "color.");
  assert.ok(r2.items.some((i) => i.label === "{color.primary}"));

  const r3 = completionsAt("plain text", 5, index);
  assert.equal(r3.kind, null);
});

test("providers: diagnosticsFor maps to 0-based ranges + unknown-ref errors", () => {
  const index = { byPath: { "color.primary": {} }, byVariable: {}, byHex: {}, completions: [] };
  const text = ".btn{color:#3b82f6}";
  const ds = diagnosticsFor(
    text,
    "a.css",
    [{ code: "hardcoded-value", message: "m", severity: "warning", line: 1, column: 12, length: 7, variable: "--color-primary" }],
    index
  );
  assert.equal(ds[0].range.start.line, 0);
  assert.equal(ds[0].range.start.character, 11);
  assert.equal(ds[0].range.end.character, 18);

  const withRef = '"x":"{color.missing}"';
  const ds2 = diagnosticsFor(withRef, "t.json", [], index);
  assert.equal(ds2.length, 1);
  assert.equal(ds2[0].code, "unknown-ref");
  assert.equal(ds2[0].severity, "error");
});

test("providers: quickFixFor rewrites literal to var(--token)", () => {
  const fix = quickFixFor({
    code: "hardcoded-value",
    variable: "--color-primary",
    range: { start: { line: 0, character: 11 }, end: { line: 0, character: 18 } },
  });
  assert.equal(fix.title, "Use --color-primary");
  assert.equal(fix.edit.replacement, "var(--color-primary)");
  assert.equal(fix.edit.range.start.character, 11);
  assert.equal(quickFixFor({ code: "unknown-ref" }), null);
});

test("language: buildLanguageIndex from MCP tool results (in-process fake)", async () => {
  const calls = [];
  const fakeCall = async (name, args) => {
    calls.push([name, args]);
    if (name === "list_tokens") {
      return { color: { primary: "#3b82f6" }, space: { md: "1rem" } };
    }
    if (name === "completions") {
      return {
        completions: [
          { label: "--color-primary", path: "color.primary", value: "#3b82f6", variable: "--color-primary", deprecated: false },
          { label: "--space-md", path: "space.md", value: "1rem", variable: "--space-md", deprecated: false },
        ],
      };
    }
    if (name === "token_info") {
      return { path: args.path, value: "#3b82f6", variable: "--color-primary", deprecated: false, dependents: [] };
    }
    throw new Error("unexpected tool " + name);
  };
  const index = await buildLanguageIndex(fakeCall);
  assert.deepEqual(calls.map((c) => c[0]), ["list_tokens", "completions"]);
  assert.equal(index.byPath["color.primary"].variable, "--color-primary");
  assert.equal(index.byVariable["--color-primary"].path, "color.primary");
  assert.equal(index.byHex["#3b82f6"].path, "color.primary");
  const info = await tokenInfo(fakeCall, {}, "color.primary");
  assert.equal(info.path, "color.primary");
});

test("vscode package: mcp command resolution", () => {
  const { command, args } = resolveMcpCommand("tokens.json", { bin: "token-to-css" });
  assert.equal(command, "token-to-css");
  assert.deepEqual(args, ["mcp", "tokens.json"]);
});
