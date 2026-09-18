import test from "node:test";
import assert from "node:assert/strict";
import {
  createMcpContext,
  handleMcpMessage,
  createTokenServer,
  previewBatchEdit,
  previewEdit,
  buildBatchCommit,
  suggestTokenName,
  proposeGrouping,
  groupTokens,
  searchTokens,
  explainToken,
  buildNameRegistry,
  lintTokens,
  applyCodemod,
  diffTokens,
} from "../src/index.js";

// A system with the shape v15 expects: a palette, a token that references it,
// a deprecated token, and a dark mode override.
const TOKENS = {
  color: {
    primary: "#3b82f6",
    primaryHover: "#1d4ed8",
    secondary: "#8b5cf6",
    background: "#ffffff",
    surface: "#f4f4f5",
  },
  space: { md: "1rem" },
  modes: { dark: { color: { background: "#0a0a0a" } } },
  deprecated: {
    old: { $value: "#999999", $type: "color", deprecated: true, replacedBy: "color.primary" },
  },
};

function call(ctx, name, args) {
  return handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx
  ).then((res) => JSON.parse(res.result.content[0].text));
}

// --- v15: batch change-requests — one reviewed unit --------------------------

const PALETTE_SHIFT = [
  { path: "color.primary", value: "#ef4444" },
  { path: "color.primaryHover", value: "#dc2626" },
  { path: "color.secondary", value: "#f97316" },
  { path: "color.background", value: "#fafafa" },
  { path: "color.surface", value: "#f5f5f5" },
];

test("v15: an agent opens ONE batched CR for a 5-token palette shift", async () => {
  const ctx = createMcpContext({ tokens: structuredClone(TOKENS) });
  const out = await call(ctx, "create_batch_change_request", {
    edits: PALETTE_SHIFT,
    reason: "brand palette shift",
    author: "agent",
  });
  // Exactly one change request — not five.
  assert.equal(ctx.changeRequests.length, 1, "one batched CR");
  assert.equal(out.ok, true);
  assert.equal(out.edits.length, 5);
  assert.equal(out.verdict.bump, "minor");
  // The single CR carries the whole proposed tree with every new value.
  const cr = ctx.changeRequests[0];
  assert.equal(cr.proposed.color.primary, "#ef4444");
  assert.equal(cr.proposed.color.surface, "#f5f5f5");
  assert.equal(cr.batch.edits.length, 5);
  assert.equal(cr.batch.verdict.bump, "minor");
  assert.equal(cr.author, "agent");
  assert.equal(cr.reason, "brand palette shift");
  // The tree was never mutated by the proposal.
  assert.equal(ctx.tokens.color.primary, "#3b82f6");
});

test("v15: batch verdict matches the single-edit preview (classified once)", () => {
  const single = previewEdit(TOKENS, { path: "color.primary", value: "#ef4444" });
  const batch = previewBatchEdit(TOKENS, [{ path: "color.primary", value: "#ef4444" }]);
  assert.equal(batch.verdict.bump, single.verdict.bump);
  assert.equal(batch.verdict.bump, "minor");
  assert.deepEqual(batch.diff.changed["color-primary"], single.diff.changed["color-primary"]);
  assert.deepEqual(batch.proposed.color.primary, "#ef4444");
});

test("v15: a batch can add a token and reference it in a later edit", () => {
  const batch = previewBatchEdit(TOKENS, [
    { path: "color.accent", value: "#22d3ee" },
    { path: "color.primaryHover", value: "{color.accent}" },
  ]);
  assert.equal(batch.ok, true);
  assert.equal(batch.proposed.color.accent, "#22d3ee");
  assert.equal(batch.proposed.color.primaryHover, "{color.accent}");
});

test("v15: a batch with a removal is major and blocks without confirmation", () => {
  // A rename removes the old path — a major verdict for the batch.
  const batch = previewBatchEdit(TOKENS, [{ rename: { from: "color.primary", to: "color.brand" } }]);
  assert.equal(batch.ok, true);
  assert.equal(batch.verdict.bump, "major");
  assert.equal(batch.blocked, true);
  assert.equal(batch.verdict.removed.length, 1);
  const confirmed = previewBatchEdit(
    TOKENS,
    [{ rename: { from: "color.primary", to: "color.brand" } }],
    { confirmed: true }
  );
  assert.equal(confirmed.blocked, false);
});

test("v15: bad edits in a batch are reported per index, not thrown", () => {
  const batch = previewBatchEdit(TOKENS, [
    { path: "color.primary", value: "#ef4444" },
    { path: "color.secondary", value: "{color.doesNotExist}" },
  ]);
  assert.equal(batch.ok, false);
  assert.equal(batch.errors.length, 1);
  assert.equal(batch.errors[0].index, 1);
  assert.equal(batch.errors[0].errors[0].code, "unknown-ref");
});

test("v15: buildBatchCommit reports failed edits without aborting the batch", () => {
  const { source, changed, errors } = buildBatchCommit(TOKENS, [
    { path: "color.primary", value: "#ef4444" },
    { rename: { from: "color.surface", to: "color.primary" } }, // collision
  ]);
  assert.equal(changed.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 1);
  assert.equal(source.color.primary, "#ef4444");
});

// --- v15: agent-authored migrations — codemod attached, governance gates -----

const REF_TOKENS = {
  color: { primary: "#3b82f6", primaryHover: "{color.primary}", surface: "#f4f4f5" },
  space: { md: "1rem" },
};

test("v15: a rename CR arrives with its codemod attached", async () => {
  const ctx = createMcpContext({ tokens: structuredClone(REF_TOKENS) });
  const out = await call(ctx, "create_migration_request", {
    from: "color.primary",
    to: "color.brand",
    reason: "rename primary -> brand",
  });
  assert.equal(out.ok, true);
  assert.equal(out.from, "color.primary");
  assert.equal(out.to, "color.brand");
  // The codemod carries the rename AND the ref update for the dependent.
  assert.ok(out.codemod.operations.some((o) => o.type === "rename"));
  assert.ok(
    out.codemod.operations.some(
      (o) => o.type === "update-ref" && o.path === "color.primaryHover" && o.newRef === "{color.brand}"
    ),
    "update-ref op rewrites the dependent"
  );
  // The CR is tagged as a migration and folds the rename + ref update.
  const cr = ctx.changeRequests[0];
  assert.equal(cr.migration.from, "color.primary");
  assert.equal(cr.migration.to, "color.brand");
  assert.equal(cr.proposed.color.brand, "#3b82f6");
  assert.equal(cr.proposed.color.primaryHover, "{color.brand}");
  assert.ok(!("primary" in cr.proposed.color));
});

test("v15: the attached codemod reproduces the migration when applied", () => {
  const ctx = createMcpContext({ tokens: structuredClone(REF_TOKENS) });
  return call(ctx, "create_migration_request", { from: "color.primary", to: "color.brand" }).then((out) => {
    const { tree } = applyCodemod(REF_TOKENS, out.codemod);
    assert.equal(tree.color.brand, "#3b82f6");
    assert.equal(tree.color.primaryHover, "{color.brand}");
    // The rename registers as a removal + add (diffTokens resolves refs, so
    // the rewritten reference itself compares equal).
    assert.deepEqual(diffTokens(REF_TOKENS, tree).removed, { "color-primary": "#3b82f6" });
    assert.deepEqual(diffTokens(REF_TOKENS, tree).added, { "color-brand": "#3b82f6" });
  });
});

test("v15: migration to a colliding path is rejected, not applied", async () => {
  const ctx = createMcpContext({ tokens: structuredClone(REF_TOKENS) });
  const out = await call(ctx, "create_migration_request", {
    from: "color.primary",
    to: "color.surface", // already a leaf
  });
  assert.equal(out.ok, false);
  assert.equal(ctx.changeRequests.length, 0);
  assert.ok(out.codemod, "codemod still returned for planning");
});

test("v15: batched CR over a live serve lands as one pending CR under --approve", async (t) => {
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
  const ctx = createMcpContext({ tokens: structuredClone(TOKENS), serveUrl: base });

  const out = await call(ctx, "create_batch_change_request", { edits: PALETTE_SHIFT });
  assert.equal(out.pending, true);
  assert.equal(out.status, "pending");
  assert.ok(out.id, "CR id from the serve approval queue");

  // One CR on the server, holding the whole palette shift.
  const crs = await (await fetch(`${base}/change-requests`)).json();
  assert.equal(crs.length, 1);
  assert.equal(crs[0].proposed.color.primary, "#ef4444");
  assert.equal(crs[0].proposed.color.secondary, "#f97316");
  // Source untouched until governance approves.
  const tree = await (await fetch(`${base}/tokens`)).json();
  assert.equal(tree.color.primary, "#3b82f6");

  // Approving folds the entire batch at once.
  const approve = await (
    await fetch(`${base}/change-requests/${crs[0].id}/approve`, { method: "POST" })
  ).json();
  assert.equal(approve.ok, true);
  const after = await (await fetch(`${base}/tokens`)).json();
  assert.equal(after.color.primary, "#ef4444");
  assert.equal(after.color.surface, "#f5f5f5");
});

test("v15: migration request over a live serve is gated by approval", async (t) => {
  const server = createTokenServer({
    tokens: structuredClone(REF_TOKENS),
    port: 0,
    watch: false,
    approve: true,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = createMcpContext({ tokens: structuredClone(REF_TOKENS), serveUrl: base });

  const out = await call(ctx, "create_migration_request", { from: "color.primary", to: "color.brand" });
  assert.equal(out.pending, true);
  assert.ok(out.codemod.operations.length >= 2, "rename + update-ref attached");
  const crs = await (await fetch(`${base}/change-requests`)).json();
  assert.equal(crs.length, 1);
  // Governance gates the merge: nothing renamed yet.
  const before = await (await fetch(`${base}/tokens`)).json();
  assert.equal(before.color.primary, "#3b82f6");
});

// --- v15: sampling tools ------------------------------------------------------

test("v15: suggest-name returns a name the linter and registry accept", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const out = await call(ctx, "suggest_name", { value: "#ef4444" });
  assert.equal(out.name, "color.ef4444");
  assert.equal(out.available, true);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.variable, "--color-ef4444");

  // The suggested name passes the linter and registry when instantiated.
  const tree = { color: { ...TOKENS.color, ef4444: "#ef4444" } };
  const { issues } = lintTokens(tree);
  assert.equal(
    issues.filter((i) => i.path === "color-ef4444").length,
    0,
    "linter accepts the suggested name"
  );
  const registry = buildNameRegistry(tree);
  assert.equal(registry.canonicalOf(["color", "ef4444"]), "color-ef4444");
  assert.ok(registry.pathOf("color-ef4444"), "registry round-trips the suggested name");
});

test("v15: suggest-name disambiguates collisions with the registry -N rule", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const out = await call(ctx, "suggest_name", { value: "#3b82f6", label: "primary" });
  // color.primary exists → the registry rule appends -2.
  assert.equal(out.name, "color.primary-2");
  assert.equal(out.available, true);
  assert.deepEqual(out.conflicts, ["color.primary"]);
  const registry = buildNameRegistry({
    color: { primary: "#3b82f6", "primary-2": "#3b82f6" },
  });
  assert.equal(registry.canonicalOf(["color", "primary-2"]), "color-primary-2");
  assert.ok(!registry.has("color-primary-2") || registry.pathOf("color-primary-2"));
});

test("v15: suggest-name over an existing path renames within its group", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const out = await call(ctx, "suggest_name", { path: "color.primaryHover" });
  assert.equal(out.name, "color.primary-hover");
  assert.equal(out.available, true);
});

test("v15: suggest-name on an unknown token says so", async () => {
  const ctx = createMcpContext({ tokens: TOKENS });
  const out = await call(ctx, "suggest_name", { path: "color.nope" });
  assert.equal(out.name, null);
  assert.equal(out.available, false);
});

// --- v15: grouping ------------------------------------------------------------

test("v15: group_tokens proposes a move and rewrites references via codemod", () => {
  const tokens = {
    color: { primary: "#3b82f6", primaryHover: "{color.primary}", surface: "#f4f4f5" },
  };
  const proposal = groupTokens(tokens, {
    paths: ["color.primary", "color.primaryHover"],
    into: "brand",
  });
  assert.deepEqual(
    proposal.operations.map((o) => [o.from, o.to]),
    [
      ["color.primary", "brand.primary"],
      ["color.primaryHover", "brand.primaryHover"],
    ]
  );
  assert.equal(proposal.tree.brand.primary, "#3b82f6");
  assert.equal(proposal.tree.brand.primaryHover, "{brand.primary}");
  assert.ok(!proposal.tree.color.primary, "moved out of the old group");
  // The proposal never mutates the source.
  assert.equal(tokens.color.primary, "#3b82f6");
  assert.ok(proposal.codemod.operations.some((o) => o.type === "update-ref"));
});

test("v15: group_tokens without paths uses a heuristic over the tree", () => {
  const tokens = { color: { a: "#3b82f6", b: "#3b82f6", c: "#ef4444" } };
  const byValue = groupTokens(tokens, { by: "value" });
  assert.ok(byValue.into, "a target group was proposed");
  assert.ok(byValue.operations.length >= 2, "the shared-value tokens move together");
  const proposals = proposeGrouping(tokens, { by: "value" });
  assert.equal(proposals.groups[0].paths.length, 2);
  assert.equal(proposals.groups[0].paths[0], "color.a");
});

test("v15: group_tokens reports tokens already in the target group", () => {
  const proposal = groupTokens(TOKENS, { paths: ["color.primary"], into: "color" });
  assert.equal(proposal.operations.length, 0);
  assert.equal(proposal.conflicts[0].reason, "already in target group");
});

// --- v15: token search --------------------------------------------------------

test("v15: search ranks a multi-term match above partial matches", () => {
  const out = searchTokens(TOKENS, "primary color");
  assert.equal(out.results[0].path, "color.primary");
  // Both terms matched → the completeness bonus outranks primaryHover.
  assert.ok(out.results[0].score > out.results.find((r) => r.path === "color.primaryHover").score);
  assert.ok(out.results[0].matched.length === 2);
});

test("v15: search boosts an exact path lookup to the top", () => {
  const out = searchTokens(TOKENS, "color.primaryHover");
  assert.equal(out.results[0].path, "color.primaryHover");
});

test("v15: search with no matches returns an empty result set", () => {
  const out = searchTokens(TOKENS, "zzz-nope");
  assert.equal(out.total, 0);
  assert.equal(out.results.length, 0);
});

test("v15: search matches values and kinds, not just paths", () => {
  const byValue = searchTokens(TOKENS, "1rem");
  assert.ok(byValue.results.some((r) => r.path === "space.md"));
  const byKind = searchTokens(TOKENS, "color");
  assert.ok(byKind.results.length >= 5);
  assert.ok(byKind.results.every((r) => r.kind === "color" || r.matched.includes("variable")));
});

// --- v15: explain -------------------------------------------------------------

test("v15: explain returns full provenance for a token", () => {
  const info = explainToken(REF_TOKENS, "color.primary");
  assert.equal(info.value, "#3b82f6");
  assert.equal(info.resolved, "#3b82f6");
  assert.equal(info.variable, "--color-primary");
  assert.equal(info.kind, "color");
  assert.equal(info.color.hex, "#3b82f6");
  assert.deepEqual(info.usedBy.direct, ["color.primaryHover"]);
  assert.deepEqual(info.refs, []);
  assert.equal(info.deprecated, false);
});

test("v15: explain reports refs consumed, deprecation, and overrides", () => {
  const info = explainToken(TOKENS, "deprecated.old");
  assert.equal(info.deprecated, true);
  assert.equal(info.replacedBy, "color.primary");
  const hover = explainToken(REF_TOKENS, "color.primaryHover");
  assert.deepEqual(hover.refs, ["color.primary"]);
  assert.equal(hover.resolved, "#3b82f6");
  const dark = explainToken(TOKENS, "color.background");
  assert.deepEqual(dark.overrides, [{ scope: "modes:dark", value: "#0a0a0a" }]);
});

test("v15: explain on an unknown token returns null (MCP errors)", async () => {
  assert.equal(explainToken(TOKENS, "color.nope"), null);
  const ctx = createMcpContext({ tokens: TOKENS });
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "explain", arguments: { path: "color.nope" } } },
    ctx
  );
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /unknown token/);
});

// --- v15: serve parity (the browser rides the same machinery) -----------------

test("v15: POST /editor/preview accepts a batch and classifies it once", async (t) => {
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
    body: JSON.stringify(PALETTE_SHIFT),
  });
  const preview = await res.json();
  assert.equal(preview.ok, true);
  assert.equal(preview.edits.length, 5);
  assert.equal(preview.verdict.bump, "minor");
  assert.equal(preview.proposed.color.primary, "#ef4444");
});

test("v15: GET /explain serves the same provenance payload as MCP", async (t) => {
  const server = createTokenServer({
    tokens: structuredClone(REF_TOKENS),
    port: 0,
    watch: false,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/explain?path=color.primary`);
  const info = await res.json();
  assert.equal(info.path, "color.primary");
  assert.deepEqual(info.usedBy.direct, ["color.primaryHover"]);
  // Parity with the in-process call.
  assert.deepEqual(info.summary, explainToken(REF_TOKENS, "color.primary").summary);
  const missing = await fetch(`${base}/explain?path=color.nope`);
  assert.equal(missing.status, 404);
  const noArg = await fetch(`${base}/explain`);
  assert.equal(noArg.status, 400);
});
