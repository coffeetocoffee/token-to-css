import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convert,
  createTokenServer,
  registerConnector,
  getConnector,
  listConnectors,
  registerStorybookConnector,
  tokensToStorybookTheme,
  storybookThemeToTokens,
  registerGithubPrConnector,
  tokensToGithubFiles,
  githubFilesToTokens,
  registerCmsConnector,
  tokensToCmsEntries,
  cmsEntriesToTokens,
} from "../src/index.js";

const tokens = {
  color: { primary: "#3b82f6", secondary: "#22c55e", background: "#ffffff", text: "#111111" },
  space: { md: "1rem" },
  radius: { sm: "4px" },
};

test("registerConnector stores and lists connectors", () => {
  const before = listConnectors().length;
  registerConnector({
    name: "demo",
    pull: async () => ({}),
    push: async () => ({}),
  });
  assert.ok(listConnectors().includes("demo"));
  assert.equal(listConnectors().length, before + 1);
  assert.equal(typeof getConnector("demo").pull, "function");
  assert.equal(getConnector("DEMO"), getConnector("demo"), "lookup is case-insensitive");
});

test("registerConnector rejects a malformed connector", () => {
  assert.throws(() => registerConnector({}), /name/);
  assert.throws(() => registerConnector({ name: "x" }), /pull/);
  assert.throws(() => registerConnector({ name: "x", pull() {} }), /push/);
});

test("Storybook connector round-trips tokens to a theme and back", () => {
  const doc = tokensToStorybookTheme(tokens);
  assert.equal(doc.theme.colorPrimary, "#3b82f6");
  assert.equal(doc.theme.appBg, "#ffffff");
  const back = storybookThemeToTokens(doc);
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
});

test("GitHub connector round-trips tokens to files and back", () => {
  const files = tokensToGithubFiles(tokens, { path: "tokens.json" });
  assert.ok(files["tokens.json"].includes('"primary"'));
  const back = githubFilesToTokens(files, { path: "tokens.json" });
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
});

test("CMS connector round-trips tokens to entries and back", () => {
  const entries = tokensToCmsEntries(tokens);
  assert.equal(entries.length, 6);
  const primary = entries.find((e) => e.id === "color.primary");
  assert.equal(primary.fields.value, "#3b82f6");
  assert.equal(primary.fields.type, "color");
  const back = cmsEntriesToTokens(entries);
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
});

test("each connector registers an opt-in output format", () => {
  registerStorybookConnector({});
  registerGithubPrConnector({});
  registerCmsConnector({});
  assert.ok(convert(tokens, { format: "storybook" }).includes('"tokens"'));
  assert.ok(convert(tokens, { format: "github" }).includes('"tokens.json"'));
  assert.ok(convert(tokens, { format: "cms" }).includes('"color.primary"'));
});

test("connector round-trips a token change end-to-end through serve with zero core changes", async () => {
  const initial = { color: { primary: "#000000" } };
  let store = structuredClone(initial);
  const name = "mem-" + Math.random().toString(36).slice(2, 8);
  registerConnector({
    name,
    pull: async () => structuredClone(store),
    push: async (tree) => {
      store = structuredClone(tree);
      return { ok: true };
    },
  });

  const server = createTokenServer({
    tokens: { color: { primary: "#abcdef" } },
    watch: false,
    streamUrl: "/events",
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  try {
    // The connector is enumerated by the mesh.
    const listed = await (await fetch(base + "/connectors")).json();
    assert.ok(listed.connectors.includes(name), "connector is listed by serve");

    // push: server tree is folded out to the external system.
    const pushRes = await fetch(base + "/connectors/" + name + "/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal((await pushRes.json()).ok, true);
    assert.equal(store.color.primary, "#abcdef", "external store received the server tree");

    // external edit happens outside the core...
    store = { color: { primary: "#123456" } };

    // pull: the external change flows back into the mesh.
    const pullRes = await fetch(base + "/connectors/" + name + "/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal((await pullRes.json()).ok, true);
    const after = await (await fetch(base + "/tokens")).json();
    assert.equal(after.color.primary, "#123456", "pulled change is live in the mesh");
  } finally {
    server.closeAll();
    server.close();
  }
});

test("serve returns 404 for an unknown connector", async () => {
  const server = createTokenServer({ tokens, watch: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  try {
    const res = await fetch(base + "/connectors/nope/pull", { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.closeAll();
    server.close();
  }
});

test("CLI emits connector formats with -f", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc8-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(input, JSON.stringify(tokens));
    for (const fmt of ["storybook", "github", "cms"]) {
      const out = join(dir, `out.${fmt}.json`);
      execFileSync("node", [CLI, input, "-f", fmt, "-o", out], { encoding: "utf8" });
      assert.ok(readFileSync(out, "utf8").length > 0, `${fmt} output written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
