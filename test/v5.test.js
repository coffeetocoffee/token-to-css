import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convert,
  reverse,
  resolveReferences,
  normalizeW3C,
  buildNameRegistry,
  registryFromJSON,
  createTokenServer,
  buildClientJS,
  registerFigmaConnector,
  tokensToFigmaVariables,
  figmaVariablesToTokens,
} from "../src/index.js";

const colliding = {
  color: { primary: "#3b82f6", primaryHover: "#2563eb", primary: { hover: "#111111" } },
  space: { md: "1rem", lg: "{space.md} * 2" },
};

test("registry round-trips colliding token names losslessly", () => {
  const reg = buildNameRegistry(colliding);
  const css = convert(colliding, { format: "css", registry: reg });
  const back = reverse(css, { registry: reg });
  const resolved = resolveReferences(normalizeW3C(colliding), { reduce: true });
  assert.equal(JSON.stringify(back), JSON.stringify(resolved));
});

test("registry survives a JSON round-trip via tokens.names.json", () => {
  const reg = buildNameRegistry(colliding);
  const json = reg.toJSON();
  const reg2 = registryFromJSON(json);
  const css = convert(colliding, { format: "css", registry: reg2 });
  const back = reverse(css, { registry: reg2 });
  const resolved = resolveReferences(normalizeW3C(colliding), { reduce: true });
  assert.equal(JSON.stringify(back), JSON.stringify(resolved));
});

test("registry disambiguates colliding canonical names", () => {
  const reg = buildNameRegistry(colliding);
  const canons = reg.entries.map((e) => e.canonical);
  assert.equal(new Set(canons).size, canons.length, "canonical names are unique");
  assert.ok(!canons.includes("color-primary-hover#2"));
  assert.ok(canons.includes("color-primary-hover-2"));
});

test("CLI --registry emits tokens.names.json and reverse --registry reproduces", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc5-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(input, JSON.stringify(colliding));
    const out = join(dir, "out.css");
    execFileSync("node", [CLI, input, "-o", out, "--registry"], { encoding: "utf8" });
    assert.ok(existsSync(out), "css written");
    const namesPath = out + ".names.json";
    assert.ok(existsSync(namesPath), "tokens.names.json written");
    const rev = join(dir, "back.json");
    execFileSync("node", [CLI, "reverse", out, "-o", rev, "--registry", namesPath], { encoding: "utf8" });
    const back = JSON.parse(readFileSync(rev, "utf8"));
    const resolved = resolveReferences(normalizeW3C(colliding), { reduce: true });
    assert.equal(JSON.stringify(back), JSON.stringify(resolved));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token server: REST reads, mode override, single token", async () => {
  const tokens = {
    color: { primary: "#3b82f6" },
    modes: { dark: { color: { primary: "#111111" } } },
  };
  const server = createTokenServer({ tokens, watch: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  try {
    const tree = await (await fetch(base + "/tokens")).json();
    assert.equal(tree.color.primary, "#3b82f6");
    const dark = await (await fetch(base + "/tokens?mode=dark")).json();
    assert.equal(dark.color.primary, "#111111");
    const one = await (await fetch(base + "/tokens/color.primary")).json();
    assert.equal(one.value, "#3b82f6");
    assert.equal(one.path, "color.primary");
    const missing = await fetch(base + "/tokens/color.nope");
    assert.equal(missing.status, 404);
  } finally {
    server.closeAll();
    server.close();
  }
});

test("token server: write scope folds a POST and pushes via SSE", async () => {
  const tokens = { color: { primary: "#3b82f6" } };
  const server = createTokenServer({ tokens, watch: false, streamUrl: "/events" });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  const es = await fetch(base + "/events");
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let gotUpdate = false;
  const loop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.includes('"update"')) {
        gotUpdate = true;
        break;
      }
    }
  })();
  try {
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(base + "/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: { primary: "#abcdef" } }),
    });
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.changed >= 1);
    await Promise.race([loop, new Promise((r) => setTimeout(r, 1000))]);
    assert.ok(gotUpdate, "SSE pushed an update after POST");
    const after = await (await fetch(base + "/tokens")).json();
    assert.equal(after.color.primary, "#abcdef");
  } finally {
    server.closeAll();
    server.close();
  }
});

test("token server: serves the generated client SDK and explorer HTML", async () => {
  const server = createTokenServer({ tokens: { color: { primary: "#3b82f6" } }, watch: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  try {
    const client = await (await fetch(base + "/tokens-client.js")).text();
    assert.ok(client.includes("TokenClient"));
    assert.ok(client.includes("EventSource"));
    const html = await (await fetch(base + "/")).text();
    assert.ok(html.includes("<!doctype html>"));
  } finally {
    server.closeAll();
    server.close();
  }
});

test("client SDK is syntactically valid JS", () => {
  const js = buildClientJS();
  assert.ok(js.includes("TokenClient"));
  // must parse without throwing
  new Function("self", js.replace("self", "this"));
});

test("Figma connector round-trips tokens to variables and back", () => {
  const tokens = { color: { primary: "#3b82f6", onPrimary: "#ffffff" }, space: { md: "1rem" } };
  const doc = tokensToFigmaVariables(tokens);
  assert.equal(doc.collections[0].variables.length, 3);
  const back = figmaVariablesToTokens(doc);
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
});

test("Figma connector registers an opt-in figma format", () => {
  registerFigmaConnector({});
  const out = convert({ color: { primary: "#3b82f6" } }, { format: "figma" });
  assert.ok(out.includes("variables"), "figma format emits a variable document");
});

test("playground HTML is served when enabled", async () => {
  const server = createTokenServer({
    tokens: { color: { primary: "#3b82f6" }, modes: { dark: {} } },
    watch: false,
    playground: true,
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const html = await (await fetch("http://localhost:" + port + "/")).text();
    assert.ok(html.includes("playground"));
    assert.ok(html.includes("Propose change"));
  } finally {
    server.closeAll();
    server.close();
  }
});
