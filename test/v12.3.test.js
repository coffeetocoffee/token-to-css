import test from "node:test";
import assert from "node:assert/strict";
import { createMcpContext, handleMcpMessage, createTokenServer, previewEdit } from "../src/index.js";

const TOKENS = {
  color: {
    primary: "#3b82f6",
    primaryHover: "#1d4ed8",
    background: "#ffffff",
  },
  space: { md: "1rem" },
  modes: { dark: { color: { primary: "#93c5fd", background: "#0a0a0a" } } },
  deprecated: {
    old: {
      $value: "#999999",
      $type: "color",
      deprecated: true,
      replacedBy: "color.primary",
    },
  },
};

function call(name, args, ctx) {
  return handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx
  ).then((res) => JSON.parse(res.result.content[0].text));
}

// --- v12.3: v7 deprecated-in-use lint as editor squiggles (MCP tool) --------

test("v12.3: diagnostics flags {deprecated.ref} uses in token files with replacedBy quick-fix", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const text = JSON.stringify(
    { surface: { alt: "{deprecated.old}", ok: "{color.primary}" } },
    null,
    2
  );
  const out = await call("diagnostics", { sources: [{ file: "tokens.json", text }] }, ctx);
  const d = out.diagnostics.find((x) => x.code === "deprecated-in-use");
  assert.ok(d, "deprecated-in-use finding expected");
  assert.equal(d.path, "deprecated.old");
  assert.equal(d.replacedBy, "color.primary");
  assert.equal(d.severity, "warning");
  // The squiggle covers the ref text inside the braces.
  const line = text.split("\n")[d.line - 1];
  assert.equal(line.substr(d.column - 1, d.length), "deprecated.old");
  assert.equal(d.quickFix.title, "Use {color.primary}");
  assert.equal(d.quickFix.replacement, "color.primary");
  // A live ref is not flagged.
  assert.equal(out.diagnostics.filter((x) => x.path === "color.primary").length, 0);
});

test("v12.3: diagnostics flags var(--deprecated) uses in consumer code", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const text = ".a { color: var(--deprecated-old); }";
  const out = await call("diagnostics", { sources: [{ file: "a.css", text }] }, ctx);
  const d = out.diagnostics.find((x) => x.code === "deprecated-in-use");
  assert.ok(d, "deprecated-in-use finding expected");
  assert.equal(d.path, "deprecated.old");
  assert.equal(d.replacedBy, "color.primary");
  assert.equal(d.value, "--deprecated-old");
  assert.equal(d.variable, "--color-primary");
  assert.equal(d.quickFix.replacement, "--color-primary");
  // The squiggle covers the --name inside var().
  assert.equal(text.substr(d.index, d.length), "--deprecated-old");
  // Explicit kind overrides the file-name inference.
  const forced = await call(
    "diagnostics",
    { sources: [{ file: "a.css", text, kind: "tokens" }] },
    ctx
  );
  assert.equal(forced.diagnostics.filter((x) => x.code === "deprecated-in-use").length, 0);
});

test("v12.3: json sources skip the hardcoded-value scan (token definitions are not consumer code)", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const text = JSON.stringify({ surface: { accent: "#1d4ed8" } }, null, 2);
  const out = await call("diagnostics", { sources: [{ file: "tokens.json", text }] }, ctx);
  assert.equal(out.diagnostics.filter((x) => x.code === "hardcoded-value").length, 0);
  // The same text as a consumer source still lints.
  const css = await call("diagnostics", { sources: [{ file: "a.css", text: "a{color:#1d4ed8}" }] }, ctx);
  assert.ok(css.diagnostics.some((x) => x.code === "hardcoded-value"));
});

// --- v12.3: true inline editing — the exact pipeline the extension drives ----
// hover → QuickPick happens editor-side; everything downstream is HTTP against
// a running serve, so this exercises the same endpoints byte-for-byte.

const EDIT = { path: "color.primary", value: "#22d3ee" };

function inlineCommitBody(edit) {
  const parts = edit.path.split(".");
  const leaf = {};
  let cur = leaf;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = edit.value;
  return leaf;
}

test("v12.3: inline color edit previews the same minor verdict the web editor computes", async (t) => {
  const server = createTokenServer({
    tokens: structuredClone(TOKENS),
    port: 0,
    watch: false,
    editor: true,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/editor/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(EDIT),
  });
  const preview = await res.json();
  assert.equal(preview.ok, true);
  assert.equal(preview.changed.path, "color.primary");
  assert.equal(preview.changed.from, "#3b82f6");
  assert.equal(preview.changed.to, "#22d3ee");
  // Parity: the in-process previewEdit for the same edit gives the same verdict.
  const direct = previewEdit(TOKENS, EDIT);
  assert.equal(preview.verdict.bump, direct.verdict.bump);
  assert.equal(preview.verdict.bump, "minor");
  assert.equal(preview.blocked, false);
});

test("v12.3: inline edit commits through the governed write scope (fold + re-broadcast)", async (t) => {
  const server = createTokenServer({
    tokens: structuredClone(TOKENS),
    port: 0,
    watch: false,
    editor: true,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inlineCommitBody(EDIT)),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.changed, 1);
  const tree = await (await fetch(`${base}/tokens`)).json();
  assert.equal(tree.color.primary, "#22d3ee");
});

test("v12.3: with --approve the inline edit lands as a change request (202)", async (t) => {
  const server = createTokenServer({
    tokens: structuredClone(TOKENS),
    port: 0,
    watch: false,
    editor: true,
    approve: true,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inlineCommitBody(EDIT)),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.ok(body.pending);
  assert.ok(body.cr.id);
  // Source tree untouched until approval.
  const tree = await (await fetch(`${base}/tokens`)).json();
  assert.equal(tree.color.primary, "#3b82f6");
});
