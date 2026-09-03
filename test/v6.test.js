import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convert,
  buildProvenance,
  lintTokens,
  createTokenServer,
  resolveReferences,
  normalizeW3C,
} from "../src/index.js";

test("OKLCH token values resolve to sRGB", () => {
  const tokens = { color: { primary: "oklch(0.7 0.15 30)" } };
  const css = convert(tokens, { format: "css" });
  const m = /--color-primary:\s*(#[0-9a-f]{6}|rgba?\([^)]+\))/i.exec(css);
  assert.ok(m, "oklch should emit an sRGB color");
  // deterministic: same input -> same output
  const css2 = convert(tokens, { format: "css" });
  assert.equal(css, css2);
});

test("lab() and oklch() work inside references (lighten over oklch)", () => {
  const tokens = {
    color: { base: "oklch(0.6 0.1 250)", lighter: "lighten(oklch(0.6 0.1 250), 20%)" },
  };
  const resolved = resolveReferences(normalizeW3C(tokens), { reduce: true });
  assert.ok(/^#|^rgba?\(/i.test(resolved.color.lighter), "lighten(oklch) should be a color");
  assert.notEqual(resolved.color.lighter, resolved.color.base);
});

test("provenance view lists tokens and reverse dependencies", () => {
  const tokens = {
    color: { primary: "#3b82f6", onPrimary: "{color.primary}" },
  };
  const html = buildProvenance(tokens);
  assert.ok(html.includes("color.primary"));
  assert.ok(html.includes("color.onPrimary"));
  assert.ok(html.includes("Used by"));
});

test("lint reports empty groups", () => {
  const tokens = { unused: { empty: {} } };
  const { issues } = lintTokens(tokens);
  const empty = issues.find((i) => i.rule === "empty-group");
  assert.ok(empty, "expected an empty-group warning");
});

test("lint empty-group is suppressible via noEmptyGroups", () => {
  const tokens = { unused: { empty: {} } };
  const { issues } = lintTokens(tokens, { noEmptyGroups: true });
  assert.ok(!issues.find((i) => i.rule === "empty-group"));
});

test("serve: read-only token is rejected (403) on POST and source is never mutated", async () => {
  const tokens = { color: { primary: "#3b82f6" } };
  const server = createTokenServer({
    tokens: structuredClone(tokens),
    watch: false,
    auth: (t) => (t === "reader" ? "read" : t === "writer" ? "write" : null),
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  try {
    const noAuth = await fetch(base + "/tokens");
    assert.equal(noAuth.status, 401);
    const readGet = await fetch(base + "/tokens", {
      headers: { authorization: "Bearer reader" },
    });
    assert.equal(readGet.status, 200);
    const writeAttempt = await fetch(base + "/tokens", {
      method: "POST",
      headers: { authorization: "Bearer reader", "content-type": "application/json" },
      body: JSON.stringify({ color: { primary: "#000000" } }),
    });
    assert.equal(writeAttempt.status, 403);
    const after = await (await fetch(base + "/tokens", { headers: { authorization: "Bearer reader" } })).json();
    assert.equal(after.color.primary, "#3b82f6", "source must not be mutated by a read-only token");
    const okWrite = await fetch(base + "/tokens", {
      method: "POST",
      headers: { authorization: "Bearer writer", "content-type": "application/json" },
      body: JSON.stringify({ color: { primary: "#000000" } }),
    });
    assert.equal(okWrite.status, 200);
    const after2 = await (await fetch(base + "/tokens", { headers: { authorization: "Bearer writer" } })).json();
    assert.equal(after2.color.primary, "#000000");
  } finally {
    server.closeAll();
    server.close();
  }
});

test("core.js re-exports the public API surface", async () => {
  const core = await import("../src/core.js");
  assert.equal(typeof core.convert, "function");
  assert.equal(typeof core.registerPlugin, "function");
  assert.equal(typeof core.buildProvenance, "function");
});
