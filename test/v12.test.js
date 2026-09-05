import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  createMcpContext,
  handleMcpMessage,
  createPlaygroundServer,
  buildLandingHTML,
} from "../src/index.js";
import { createTokenServer } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.js");

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

// --- MCP language tools (extension backend) -------------------------------

test("v12: token_info returns value, swatch hex, variable, kind", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const info = await call("token_info", { path: "color.primary" }, ctx);
  assert.equal(info.path, "color.primary");
  assert.equal(info.value, "#3b82f6");
  assert.equal(info.variable, "--color-primary");
  assert.equal(info.color.hex, "#3b82f6");
  assert.equal(info.kind, "color");
  assert.equal(info.deprecated, false);
  assert.deepEqual(info.dependents, []);

  const dim = await call("token_info", { path: "space.md" }, ctx);
  assert.equal(dim.kind, "dimension");
  assert.equal(dim.color, null);
});

test("v12: token_info surfaces deprecation + dependents", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const info = await call("token_info", { path: "deprecated.old" }, ctx);
  assert.equal(info.deprecated, true);
  assert.equal(info.replacedBy, "color.primary");
});

test("v12: token_info throws for an unknown path", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "token_info", arguments: { path: "color.missing" } } },
    ctx
  );
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /unknown token/);
});

test("v12: completions kind=css returns --var names filtered by prefix", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const out = await call("completions", { kind: "css", prefix: "color-p" }, ctx);
  const labels = out.completions.map((c) => c.label);
  assert.ok(labels.includes("--color-primary"));
  assert.ok(labels.includes("--color-primary-hover"));
  assert.ok(!labels.includes("--space-md"));
});

test("v12: completions kind=ref returns {dotted} refs + deprecation metadata", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const out = await call("completions", { kind: "ref", prefix: "" }, ctx);
  assert.ok(out.completions.some((c) => c.label === "{color.primary}"));
  assert.ok(out.completions.some((c) => c.label === "{space.md}"));
  const dep = out.completions.find((c) => c.path === "deprecated.old");
  assert.equal(dep.deprecated, true);
  assert.equal(dep.replacedBy, "color.primary");
  assert.match(dep.detail, /deprecated/);
});

test("v12: diagnostics reports hardcoded values with quick-fix (1-based line/col)", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const text = ".btn { color: #3b82f6; padding: 1rem; }";
  const out = await call("diagnostics", { sources: [{ file: "app.css", text }] }, ctx);
  const hex = out.diagnostics.find((d) => d.value === "#3b82f6");
  assert.ok(hex, "hex finding expected");
  assert.equal(hex.code, "hardcoded-value");
  assert.equal(hex.line, 1);
  assert.equal(hex.column, 15);
  assert.equal(hex.length, 7);
  assert.equal(hex.variable, "--color-primary");
  assert.equal(hex.exact, true);
  assert.equal(hex.quickFix.title, "Use --color-primary");
  const dim = out.diagnostics.find((d) => d.value === "1rem");
  assert.ok(dim, "dimension finding expected");
  // Nothing matched -> empty.
  const none = await call("diagnostics", { sources: [{ file: "x.css", text: "a{color:#123456}" }] }, ctx);
  assert.equal(none.diagnostics.length, 0);
});

test("v12: tools/list advertises the new language tools", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const res = handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx);
  const names = res.result.tools.map((t) => t.name);
  for (const n of ["list_tokens", "impact", "create_change_request", "token_info", "completions", "diagnostics"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
});

test("v12: mcp CLI boots via spawn (stdio JSON-RPC, as the extension drives it)", async () => {
  const { spawn } = await import("node:child_process");
  const fixture = join(here, "fixtures", "w3c.json");
  const child = spawn(process.execPath, [CLI, "mcp", fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const reply = (id) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 10000);
      const check = () => {
        const line = lines.find((l) => {
          try {
            return JSON.parse(l).id === id;
          } catch {
            return false;
          }
        });
        if (line) {
          clearTimeout(t);
          resolve(JSON.parse(line));
        } else {
          setTimeout(check, 25);
        }
      };
      check();
    });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await reply(1);
    assert.equal(init.result.serverInfo.name, "token-to-css");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "token_info", arguments: { path: "color.primary" } } });
    const res = await reply(2);
    const info = JSON.parse(res.result.content[0].text);
    assert.equal(info.value, "#3b82f6");
  } finally {
    child.kill();
  }
});

// --- Hosted web playground -------------------------------------------------

test("v12: playground landing page renders", () => {
  const html = buildLandingHTML();
  assert.match(html, /<textarea id="tokens"/);
  assert.match(html, /id="serveUrl"/);
  assert.match(html, /\/session/);
});

test("v12: createPlaygroundServer boots a session with editor + playground", async () => {
  const hub = await createPlaygroundServer();
  try {
    const session = await hub.createSession({ tokens: structuredClone(TOKENS) });
    assert.ok(session.url.startsWith("http://localhost:"));
    const page = await fetch(session.url).then((r) => r.text());
    assert.match(page, /Live design-system playground/);
    // The session is a real Token Server: the editor route works.
    const editor = await fetch(session.url.replace(/\/$/, "") + "/editor").then((r) => r.text());
    assert.match(editor, /data-path="color\.primary"|data-var="--color-primary"/);
    // And the v10.5 preview pipeline is intact.
    const preview = await fetch(session.url.replace(/\/$/, "") + "/editor/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "color.primary", value: "#ff0000" }),
    }).then((r) => r.json());
    assert.equal(preview.ok, true);
    assert.equal(preview.verdict.bump, "minor");
  } finally {
    hub.closeAll();
    hub.close();
  }
});

test("v12: session commits fold into the session tree (POST /tokens)", async () => {
  const hub = await createPlaygroundServer();
  try {
    const session = await hub.createSession({ tokens: structuredClone(TOKENS) });
    const base = session.url.replace(/\/$/, "");
    const post = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: { primary: "#00ff00" } }),
    }).then((r) => r.json());
    assert.equal(post.ok, true);
    assert.ok(post.changed >= 1);
    const tree = await fetch(`${base}/tokens`).then((r) => r.json());
    assert.equal(tree.color.primary, "#00ff00");
  } finally {
    hub.closeAll();
    hub.close();
  }
});

test("v12: session from a pasted token file (tokensText) works", async () => {
  const hub = await createPlaygroundServer();
  try {
    const session = await hub.createSession({ tokensText: JSON.stringify({ a: { b: "1px" } }) });
    const base = session.url.replace(/\/$/, "");
    const tree = await fetch(`${base}/tokens`).then((r) => r.json());
    assert.equal(tree.a.b, "1px");
  } finally {
    hub.closeAll();
    hub.close();
  }
});

test("v12: session from a running serve URL mirrors the remote tree", async () => {
  const server = createTokenServer({ tokens: structuredClone(TOKENS), watch: false });
  await new Promise((r) => server.listen(0, r));
  const remoteBase = `http://localhost:${server.address().port}`;
  try {
    const hub = await createPlaygroundServer();
    try {
      const session = await hub.createSession({ serveUrl: remoteBase });
      const tree = await fetch(session.url.replace(/\/$/, "") + "/tokens").then((r) => r.json());
      assert.equal(tree.color.primary, "#3b82f6");
      assert.ok(session.remote);
    } finally {
      hub.closeAll();
      hub.close();
    }
  } finally {
    server.closeAll();
    server.close();
  }
});

test("v12: propose endpoint forwards to the remote write scope (approve → 202 CR)", async () => {
  const server = createTokenServer({ tokens: structuredClone(TOKENS), watch: false, approve: true });
  await new Promise((r) => server.listen(0, r));
  const remoteBase = `http://localhost:${server.address().port}`;
  const srcTree = structuredClone(TOKENS);
  try {
    const hub = await createPlaygroundServer();
    try {
      const session = await hub.createSession({ serveUrl: remoteBase });
      const result = await hub.proposeToRemote(session, { color: { primary: "#123456" } });
      assert.equal(result.ok, true);
      assert.equal(result.pending, true);
      assert.ok(result.cr && result.cr.id);
      // The remote source is untouched until approval.
      assert.equal(server.getSourceTree().color.primary, srcTree.color.primary);
      assert.equal(server.changeRequests.length, 1);
      // The session preview mirrors the (unchanged) remote tree.
      const preview = await fetch(session.url.replace(/\/$/, "") + "/tokens").then((r) => r.json());
      assert.equal(preview.color.primary, srcTree.color.primary);
    } finally {
      hub.closeAll();
      hub.close();
    }
  } finally {
    server.closeAll();
    server.close();
  }
});

test("v12: landing page served at GET / + 404 otherwise", async () => {
  const hub = await createPlaygroundServer();
  await new Promise((r) => hub.listen(0, r));
  try {
    const base = `http://localhost:${hub.address().port}`;
    const page = await fetch(base).then((r) => r.text());
    assert.match(page, /Live design-system playground/);
    const miss = await fetch(`${base}/nope`);
    assert.equal(miss.status, 404);
  } finally {
    hub.closeAll();
    hub.close();
  }
});

test("v12: playground CLI subcommand exists in help", async () => {
  const { execFile } = await import("node:child_process");
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, "--help"], (err, stdout) => resolve(stdout || ""));
  });
  assert.match(out, /playground/);
});
