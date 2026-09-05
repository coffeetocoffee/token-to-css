import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateEditValue,
  buildEditCommit,
  editImpact,
  previewEdit,
  buildEditorHTML,
  createTokenServer,
  diffTokens,
} from "../src/index.js";

const source = {
  color: { primary: "#3b82f6", muted: "{color.primary}" },
  space: { md: "1rem" },
  modes: { dark: { color: { primary: "#60a5fa" } } },
  brands: { acme: { space: { md: "1.5rem" } } },
};

// --- validateEditValue ---

test("validateEditValue: empty value is rejected", () => {
  const errs = validateEditValue("", source);
  assert.ok(errs.some((e) => e.code === "empty-value"));
});

test("validateEditValue: unknown {ref} is rejected and valid tokens offered", () => {
  const errs = validateEditValue("{color.doesnotexist}", source);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, "unknown-ref");
  assert.equal(errs[0].ref, "color.doesnotexist");
  assert.ok(errs[0].valid.includes("color.primary"));
  assert.ok(errs[0].valid.includes("modes.dark.color.primary"));
});

test("validateEditValue: valid {ref} passes", () => {
  assert.deepEqual(validateEditValue("{color.primary}", source), []);
});

test("validateEditValue: bad color literal is rejected, good one passes", () => {
  assert.ok(validateEditValue("#notacolor", source).some((e) => e.code === "bad-color"));
  assert.deepEqual(validateEditValue("#2563eb", source), []);
  assert.deepEqual(validateEditValue("oklch(0.62 0.19 260)", source), []);
});

test("validateEditValue: non-color literals pass untouched", () => {
  assert.deepEqual(validateEditValue("1.5rem", source), []);
});

// --- buildEditCommit ---

test("buildEditCommit: base value edit is pure and precise", () => {
  const { source: next, changed } = buildEditCommit(source, { path: "color.primary", value: "#2563eb" });
  assert.notEqual(next, source, "source untouched");
  assert.deepEqual(source.color, { primary: "#3b82f6", muted: "{color.primary}" });
  assert.equal(next.color.primary, "#2563eb");
  assert.equal(changed.type, "value");
  assert.equal(changed.scope, "base");
  assert.equal(changed.from, "#3b82f6");
  assert.equal(changed.to, "#2563eb");
  assert.equal(changed.creates, false);
});

test("buildEditCommit: mode edit writes into modes.dark, not base", () => {
  const { source: next, changed } = buildEditCommit(source, { path: "color.primary", value: "#93c5fd", mode: "dark" });
  assert.equal(next.color.primary, "#3b82f6", "base untouched");
  assert.equal(next.modes.dark.color.primary, "#93c5fd", "mode subtree updated");
  assert.equal(changed.scope, "mode:dark");
});

test("buildEditCommit: mode override creates new subtree token and flags it", () => {
  const { source: next, changed } = buildEditCommit(source, { path: "radius.sm", value: "4px", mode: "dark" });
  assert.equal(next.modes.dark.radius.sm, "4px");
  assert.equal(changed.override, true);
  assert.equal(changed.creates, true);
});

test("buildEditCommit: brand edit writes into brands.acme", () => {
  const { source: next, changed } = buildEditCommit(source, { path: "space.md", value: "2rem", brand: "acme" });
  assert.equal(next.space.md, "1rem", "base untouched");
  assert.equal(next.brands.acme.space.md, "2rem");
  assert.equal(changed.scope, "brand:acme");
});

test("buildEditCommit: W3C $value leaves are updated in place", () => {
  const w3c = { color: { primary: { $value: "#3b82f6", $type: "color" } } };
  const { source: next } = buildEditCommit(w3c, { path: "color.primary", value: "#000000" });
  assert.equal(next.color.primary.$value, "#000000");
  assert.equal(next.color.primary.$type, "color");
});

test("buildEditCommit: rename moves the leaf and updates refs via the codemod engine", () => {
  const { source: next, changed } = buildEditCommit(source, { rename: { from: "color.primary", to: "color.brand.primary" } });
  assert.equal(next.color.primary, undefined);
  assert.equal(next.color.brand.primary, "#3b82f6");
  assert.equal(next.color.muted, "{color.brand.primary}", "reference rewritten");
  assert.equal(changed.type, "rename");
  assert.equal(changed.operations, 2, "rename + update-ref");
});

test("buildEditCommit: rename colliding into an existing leaf throws", () => {
  assert.throws(() => buildEditCommit(source, { rename: { from: "space.md", to: "color.primary" } }), /collides/);
});

test("buildEditCommit: missing path/value throws", () => {
  assert.throws(() => buildEditCommit(source, { path: "color.primary" }), /value/);
  assert.throws(() => buildEditCommit(source, { value: "x" }), /path/);
});

// --- editImpact ---

test("editImpact: reports dependents from the v7 impact graph", () => {
  const impact = editImpact(source, "color.primary");
  assert.ok(impact.direct.includes("color.muted"));
  assert.ok(impact.transitive.includes("color.muted"));
});

test("editImpact: deprecated token reports its replacedBy migration path", () => {
  const withDep = { color: { old: { $value: "#000", deprecated: true, replacedBy: "color.new" } } };
  const impact = editImpact(withDep, "color.old");
  assert.equal(impact.deprecated, true);
  assert.equal(impact.replacedBy, "color.new");
});

// --- previewEdit ---

test("previewEdit: value change is a minor verdict, not blocked", () => {
  const p = previewEdit(source, { path: "color.primary", value: "#2563eb" });
  assert.equal(p.ok, true);
  assert.equal(p.verdict.bump, "minor");
  assert.equal(p.blocked, false);
  assert.equal(p.diff.changed["color-primary"].from, "#3b82f6");
  assert.equal(p.diff.changed["color-primary"].to, "#2563eb");
  assert.ok(p.impact.direct.includes("color.muted"));
});

test("previewEdit: rename is a removal -> major verdict, blocked unless confirmed", () => {
  const p = previewEdit(source, { rename: { from: "color.primary", to: "color.brand.primary" } });
  assert.equal(p.ok, true);
  assert.equal(p.verdict.bump, "major");
  assert.equal(p.blocked, true, "removal blocks the commit");
  assert.ok(p.codemod);
  assert.ok(p.codemod.operations.some((o) => o.type === "rename"));
  assert.ok(p.codemod.operations.some((o) => o.type === "update-ref" && o.newRef === "{color.brand.primary}"));
  const p2 = previewEdit(source, { rename: { from: "color.primary", to: "color.brand.primary" }, confirmed: true });
  assert.equal(p2.blocked, false, "explicit confirmation unblocks");
});

test("previewEdit: invalid edit reports errors and produces no diff", () => {
  const p = previewEdit(source, { path: "color.primary", value: "{nope.nope}" });
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => e.code === "unknown-ref"));
  assert.deepEqual(p.diff, { added: {}, removed: {}, changed: {} });
  assert.equal(p.verdict.bump, "none");
});

test("previewEdit: rename carries the ready-to-run v7 codemod", () => {
  const p = previewEdit(source, { rename: { from: "color.primary", to: "color.brand.primary" }, confirmed: true });
  assert.equal(p.ok, true);
  assert.ok(p.codemod);
  assert.ok(p.codemod.operations.some((o) => o.type === "rename"));
  assert.ok(p.codemod.operations.some((o) => o.type === "update-ref" && o.newRef === "{color.brand.primary}"));
});

test("previewEdit: never mutates the source", () => {
  const before = JSON.stringify(source);
  previewEdit(source, { path: "color.primary", value: "#111111" });
  previewEdit(source, { rename: { from: "color.primary", to: "color.x" } });
  assert.equal(JSON.stringify(source), before);
});

// --- server integration ---

test("GET /editor serves the editable explorer with controls", async () => {
  const server = createTokenServer({ tokens: source, watch: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const res = await fetch(`http://localhost:${port}/editor`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Visual token editor/);
  assert.match(html, /data-var="color-primary"/);
  assert.match(html, /editor\/preview/);
  assert.match(html, /<input type="color"/);
  server.closeAll();
  server.close();
  await new Promise((r) => server.close(r));
});

test("GET /editor shows mode and brand scopes and canary channel when enabled", async () => {
  const server = createTokenServer({ tokens: source, watch: false, channels: { canary: source } });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const html = await (await fetch(`http://localhost:${port}/editor`)).text();
  assert.match(html, /<option value="dark">dark<\/option>/);
  assert.match(html, /<option value="acme">acme<\/option>/);
  assert.match(html, /<option value="canary">canary<\/option>/);
  server.closeAll();
  server.close();
});

test("POST /editor/preview returns the dry-run payload over the wire", async () => {
  const server = createTokenServer({ tokens: source, watch: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const res = await fetch(`http://localhost:${port}/editor/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "color.primary", value: "#2563eb" }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.verdict.bump, "minor");
  assert.ok(body.impact.direct.includes("color.muted"));
  server.closeAll();
  server.close();
});

test("editor commit flows through POST /tokens write scope and re-broadcasts", async () => {
  const server = createTokenServer({ tokens: structuredClone(source), watch: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  let gotUpdate = false;
  const es = await fetch(`${base}/events`);
  const reader = es.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const loop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      if (buf.includes('"update"')) {
        gotUpdate = true;
        break;
      }
    }
  })();
  try {
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: { primary: "#2563eb" } }),
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.changed, 1);

    await Promise.race([loop, new Promise((r) => setTimeout(r, 1000))]);
    assert.ok(gotUpdate, "SSE update broadcast");
  } finally {
    server.closeAll();
    server.close();
  }
});

test("editor commit with --approve queues a change-request (202) instead of writing", async () => {
  const server = createTokenServer({ tokens: structuredClone(source), watch: false, approve: true });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const res = await fetch(`http://localhost:${port}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: { primary: "#2563eb" } }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.ok(body.pending);
  const crs = await (await fetch(`http://localhost:${port}/change-requests`)).json();
  assert.equal(crs.length, 1);
  server.closeAll();
  server.close();
});

test("canary channel: editor commit lands in canary until promoted", async () => {
  const server = createTokenServer({
    tokens: structuredClone(source),
    watch: false,
    channels: { canary: structuredClone(source) },
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://localhost:${port}/tokens?channel=canary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: { primary: "#f97316" } }),
  });
  assert.equal((await res.json()).channel, "canary");

  const canaryNow = await (await fetch(`http://localhost:${port}/tokens?channel=canary`)).json();
  assert.equal(canaryNow.color.primary, "#f97316", "canary tree updated");
  const stableNow = await (await fetch(`http://localhost:${port}/tokens`)).json();
  assert.equal(stableNow.color.primary, "#3b82f6", "stable untouched");
  server.closeAll();
  server.close();
});

test("read-only scope: editor commit is rejected with 403 and source never mutated", async () => {
  const tree = structuredClone(source);
  const server = createTokenServer({
    tokens: tree,
    watch: false,
    auth: { "ro-token": "read" },
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const before = JSON.stringify(tree);

  const res = await fetch(`http://localhost:${port}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ro-token" },
    body: JSON.stringify({ color: { primary: "#111111" } }),
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.stringify(tree), before, "source untouched");
  server.closeAll();
  server.close();
});

test("diff-before-commit over the wire matches diffTokens", async () => {
  const server = createTokenServer({ tokens: source, watch: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const { source: next } = await import("../src/index.js").then((m) =>
    m.buildEditCommit(source, { path: "space.md", value: "2rem" })
  );
  const expected = diffTokens(source, next);
  const res = await fetch(`http://localhost:${port}/editor/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "space.md", value: "2rem" }),
  });
  const body = await res.json();
  assert.deepEqual(body.diff, expected);
  server.closeAll();
  server.close();
});

// --- HTML artifact sanity ---

test("buildEditorHTML renders type-aware controls and deprecation hints", () => {
  const withDep = {
    color: { old: { $value: "#000000", deprecated: true, replacedBy: "color.new" }, new: "#111111" },
    space: { md: "1rem" },
  };
  const html = buildEditorHTML(withDep);
  assert.match(html, /deprecated → <code>\{color\.new\}<\/code>/);
  assert.match(html, /class="pick"/);
  assert.match(html, /class="step"/);
});

test("buildEditorHTML with editable:false disables controls (read-only)", () => {
  const html = buildEditorHTML(source, { editable: false });
  assert.match(html, /disabled/);
  assert.match(html, /read-only/);
});
