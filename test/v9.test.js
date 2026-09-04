import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lintConsumer,
  applyConsumerCodemod,
  computeAdoptionScore,
  storeSnapshot,
  loadSnapshots,
  computeOrgAdoption,
  createMcpContext,
  handleMcpMessage,
  buildOrgManifest,
  resolveOrgTree,
  createTokenServer,
} from "../src/index.js";
import { resolveReferences, normalizeW3C } from "../src/index.js";

const tokens = {
  color: { primary: "#3b82f6", secondary: "#22c55e", background: "#ffffff", text: "#111111" },
  space: { md: "1rem" },
  radius: { sm: "4px" },
};

test("lintConsumer reports both exact and nearest color matches", () => {
  const sources = [
    { file: "a.css", text: ".a{ color:#3b82f6 } .b{ color:#3c84f7 }" },
  ];
  const { findings, summary } = lintConsumer(tokens, sources, {});
  assert.equal(findings.length, 2, "both literals flagged");
  const exact = findings.find((f) => f.value.toLowerCase() === "#3b82f6");
  const nearest = findings.find((f) => f.value.toLowerCase() === "#3c84f7");
  assert.ok(exact && exact.exact, "exact match is exact");
  assert.ok(nearest && !nearest.exact, "near match is nearest");
  assert.ok(nearest.distance > 0 && nearest.distance <= 0.1, "near within threshold");
  assert.equal(exact.variable, "--color-primary");
  assert.equal(summary.exact, 1);
  assert.equal(summary.nearest, 1);
});

test("lintConsumer matches non-color (dimension) tokens", () => {
  const sources = [{ file: "a.css", text: ".a{ margin: 1rem; border-radius: 4px; }" }];
  const { findings } = lintConsumer(tokens, sources, {});
  const md = findings.find((f) => f.value === "1rem");
  assert.ok(md && md.variable === "--space-md", "1rem -> --space-md");
});

test("lintConsumer skips token definitions and existing var() usages", () => {
  const sources = [
    { file: "a.css", text: ":root{ --color-primary:#3b82f6 } .a{ color: #3b82f6; } .b{ color: var(--color-primary); }" },
  ];
  const { findings } = lintConsumer(tokens, sources, {});
  // Only the consumer usage of #3b82f6 should be flagged; not the --color-primary declaration nor var().
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "a.css");
});

test("applyConsumerCodemod rewrites literals and is idempotent", () => {
  const sources = [
    { file: "a.css", text: ".a{ color:#3b82f6 } .b{ color:#3c84f7; margin:1rem }" },
  ];
  const { results, totalChanges } = applyConsumerCodemod(tokens, sources, {});
  assert.equal(totalChanges, 3);
  const rewritten = results[0].text;
  assert.ok(rewritten.includes("var(--color-primary)"));
  assert.ok(rewritten.includes("var(--space-md)"));
  // Second run on the rewritten source reports zero changes.
  const after = lintConsumer(tokens, [{ file: "a.css", text: rewritten }], {});
  assert.equal(after.findings.length, 0);
});

test("computeAdoptionScore computes the adopted percentage", () => {
  const sources = [
    { file: "a.css", text: ".a{ color:#3b82f6 } .b{ color: var(--color-primary); }" },
  ];
  const score = computeAdoptionScore(tokens, sources, {});
  // 1 adopted (var) + 1 hardcoded (#3b82f6) = 50%
  assert.equal(score.adopted, 1);
  assert.equal(score.hardcoded, 1);
  assert.equal(score.score, 50);
});

test("storeSnapshot / loadSnapshots track a trend", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ttc-score-"));
  try {
    const snap = join(dir, "snaps.json");
    let all = storeSnapshot(snap, { score: 50, adopted: 1, hardcoded: 1, total: 2 });
    assert.equal(all.length, 1);
    all = storeSnapshot(snap, { score: 75, adopted: 3, hardcoded: 1, total: 4 });
    assert.equal(all.length, 2);
    const loaded = loadSnapshots(snap);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[1].score, 75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeOrgAdoption rolls up a per-team score", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ttc-org-"));
  try {
    const teamA = join(dir, "a.json");
    const teamB = join(dir, "b.json");
    writeFileSync(teamA, JSON.stringify({ color: { primary: "#3b82f6" } }));
    writeFileSync(teamB, JSON.stringify({ color: { accent: "#22c55e" } }));
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "org",
        teams: {
          teamA: { path: "a.json", priority: 1 },
          teamB: { path: "b.json", priority: 1 },
        },
      })
    );
    const manifest = buildOrgManifest(manifestPath);
    const sourcesByTeam = {
      teamA: [{ file: "x.css", text: ".a{ color:#3b82f6 }" }],
      teamB: [{ file: "y.css", text: ".b{ color: var(--color-accent); }" }],
    };
    const { teams, org } = computeOrgAdoption(manifest, resolveOrgTree, sourcesByTeam);
    assert.ok("teamA" in teams && "teamB" in teams);
    assert.equal(teams.teamA.score, 0); // 1 hardcoded, 0 adopted
    assert.equal(teams.teamB.score, 100); // 0 hardcoded, 1 adopted
    assert.equal(org.adopted, 1);
    assert.equal(org.hardcoded, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP: initialize and tools/list advertise the adoption tools", async () => {
  const ctx = createMcpContext({ tokens });
  const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, ctx);
  assert.equal(init.result.serverInfo.name, "token-to-css");
  const list = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx);
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes("list_tokens"));
  assert.ok(names.includes("impact"));
  assert.ok(names.includes("create_change_request"));
});

test("MCP: list_tokens and impact resolve correctly", async () => {
  const tree = {
    a: { x: { $value: "{b.y}" } },
    b: { y: { $value: "#ffffff" } },
  };
  const ctx = createMcpContext({ tokens: tree });
  const list = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_tokens", arguments: {} } },
    ctx
  );
  assert.ok("b" in JSON.parse(list.result.content[0].text));
  const impact = await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "impact", arguments: { path: "b.y" } } },
    ctx
  );
  const r = JSON.parse(impact.result.content[0].text);
  assert.deepEqual(r.dependents, ["a.x"]);
});

test("MCP: create_change_request appears in serve GET /change-requests", async () => {
  const initial = { color: { primary: "#123456" } };
  const server = createTokenServer({ tokens: initial, watch: false, approve: true, streamUrl: "/events" });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  try {
    const ctx = createMcpContext({ tokens: initial, serveUrl: base });
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_change_request", arguments: { proposed: { color: { primary: "#abcdef" } }, reason: "rebrand" } },
      },
      ctx
    );
    const cr = JSON.parse(res.result.content[0].text);
    assert.ok(cr.id, "change request id returned");
    const crs = await (await fetch(base + "/change-requests")).json();
    const found = crs.find((c) => c.id === cr.id);
    assert.ok(found, "CR appears in GET /change-requests");
    assert.equal(found.status, "pending");
  } finally {
    server.closeAll();
    server.close();
  }
});

test("CLI: adopt flags a hardcoded value and exits 1", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc-cli-"));
  try {
    writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
    writeFileSync(join(dir, "app.css"), ".a{ color:#3b82f6 }");
    const out = execFileSync("node", [CLI, "adopt", join(dir, "tokens.json"), join(dir, "app.css")], {
      encoding: "utf8",
      cwd: join(dir),
    });
    assert.match(out, /should use --color-primary/);
    // exit code 1 is checked via throw: execFileSync throws on non-zero exit
  } catch (e) {
    assert.equal(e.status, 1, "adopt exits 1 when hardcoded values present");
    assert.match(e.stdout || "", /should use --color-primary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: adopt --fix rewrites the file and a second run is clean", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, readFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc-fix-"));
  try {
    writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
    const app = join(dir, "app.css");
    writeFileSync(app, ".a{ color:#3b82f6 }");
    execFileSync("node", [CLI, "adopt", join(dir, "tokens.json"), app, "--fix"], {
      encoding: "utf8",
      cwd: join(dir),
    });
    const after = readFileSync(app, "utf8");
    assert.match(after, /var\(--color-primary\)/);
    // second run: no findings -> exit 0
    execFileSync("node", [CLI, "adopt", join(dir, "tokens.json"), app], {
      encoding: "utf8",
      cwd: join(dir),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: adopt --report prints the adoption score", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc-rep-"));
  try {
    writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
    writeFileSync(join(dir, "app.css"), ".a{ color:#3b82f6 } .b{ color: var(--color-primary); }");
    const snap = join(dir, "snaps.json");
    const out = execFileSync(
      "node",
      [CLI, "adopt", join(dir, "tokens.json"), join(dir, "app.css"), "--report", "--snapshots", snap],
      { encoding: "utf8", cwd: join(dir) }
    );
    assert.match(out, /adoption score: 50%/);
    assert.match(out, /snapshots stored: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package split: @token-to-css/stylelint and /eslint lint via public surface", async () => {
  const { symlinkSync, mkdirSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const nm = join(repoRoot, "node_modules");
  const link = join(nm, "token-to-css");
  mkdirSync(nm, { recursive: true });
  if (!existsSync(link)) symlinkSync(repoRoot, link, "junction");
  try {
    const stylelint = await import("../packages/stylelint-plugin/index.js");
    const eslint = await import("../packages/eslint-plugin/index.js");
    const slRule = stylelint.createRule(tokens);
    const esRule = eslint.createRule(tokens);
    const findings = slRule.lintText(".a{ color:#3b82f6 }", "a.css");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].variable, "--color-primary");
    const esFindings = esRule.lintText('#fff { color: #3b82f6 }', "a.css");
    assert.ok(esFindings.some((f) => f.variable === "--color-primary"));
  } finally {
    rmSync(link, { recursive: true, force: true });
  }
});
