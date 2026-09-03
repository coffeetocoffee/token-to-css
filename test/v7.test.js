import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  addVersionMarkers,
  getDeprecations,
  createChangeRequest,
  approveChangeRequest,
  rejectChangeRequest,
  applyChangeRequest,
} from "../src/governance.js";
import {
  getImpactGraph,
  getTransitiveDependents,
  generateCodemod,
  applyCodemod,
  generateCSSCodemod,
} from "../src/migrate.js";
import {
  buildOrgManifest,
  validateManifest,
  resolveOrgTree,
  lintOrg,
  mergeRegistries,
} from "../src/federation.js";
import {
  createNamespacedAuth,
  createFlatNamespacedAuth,
} from "../src/namespaces.js";
import { buildNameRegistry, lintTokens, validateTokens } from "../src/index.js";
import { buildProvenance } from "../src/docs.js";

const tmpDir = join(tmpdir(), `token-to-css-v7-test-${Date.now()}`);

function setup() {
  mkdirSync(tmpDir, { recursive: true });
}

function teardown() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ============================================================
// Governance
// ============================================================

describe("v7: governance", () => {
  it("addVersionMarkers stamps $version on leaves", () => {
    const tokens = {
      color: { primary: { $value: "#3b82f6", $type: "color" } },
    };
    const result = addVersionMarkers(tokens, "2.0.0");
    assert.equal(result.color.primary.$version, "2.0.0");
    assert.equal(result.color.primary.$value, "#3b82f6");
  });

  it("addVersionMarkers does not overwrite existing $version", () => {
    const tokens = {
      color: { primary: { $value: "#3b82f6", $type: "color", $version: "1.0.0" } },
    };
    const result = addVersionMarkers(tokens, "2.0.0");
    assert.equal(result.color.primary.$version, "1.0.0");
  });

  it("getDeprecations returns deprecated tokens", () => {
    const tokens = {
      color: {
        primary: { $value: "#3b82f6", $type: "color" },
        old: { $value: "#000", $type: "color", deprecated: true, replacedBy: "color.primary" },
      },
    };
    const deps = getDeprecations(tokens);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].path, "color.old");
    assert.equal(deps[0].replacedBy, "color.primary");
  });

  it("createChangeRequest creates a pending CR", () => {
    const current = { color: { primary: { $value: "#3b82f6" } } };
    const proposed = { color: { primary: { $value: "#ef4444" } } };
    const cr = createChangeRequest(current, proposed, { author: "test" });
    assert.equal(cr.status, "pending");
    assert.equal(cr.author, "test");
    assert.ok(cr.id.startsWith("cr-"));
  });

  it("approveChangeRequest marks CR as approved", () => {
    const cr = createChangeRequest({}, {});
    approveChangeRequest(cr);
    assert.equal(cr.status, "approved");
    assert.ok(cr.approved);
  });

  it("approveChangeRequest throws on non-pending CR", () => {
    const cr = createChangeRequest({}, {});
    approveChangeRequest(cr);
    assert.throws(() => approveChangeRequest(cr), /not pending/);
  });

  it("rejectChangeRequest marks CR as rejected", () => {
    const cr = createChangeRequest({}, {});
    rejectChangeRequest(cr, "no reason");
    assert.equal(cr.status, "rejected");
    assert.equal(cr.rejectionReason, "no reason");
  });

  it("applyChangeRequest merges proposed into source", () => {
    const source = { color: { primary: { $value: "#3b82f6" } } };
    const cr = createChangeRequest(source, { color: { primary: { $value: "#ef4444" } } });
    approveChangeRequest(cr);
    const { tree } = applyChangeRequest(source, cr);
    assert.equal(tree.color.primary.$value, "#ef4444");
  });

  it("applyChangeRequest throws on non-approved CR", () => {
    const cr = createChangeRequest({}, {});
    assert.throws(() => applyChangeRequest({}, cr), /not approved/);
  });
});

// ============================================================
// Migration
// ============================================================

describe("v7: migration", () => {
  const tokens = {
    color: {
      primary: { $value: "#3b82f6", $type: "color" },
      button: { bg: { $value: "{color.primary}", $type: "color" } },
    },
    spacing: {
      md: { $value: "16px", $type: "dimension" },
    },
  };

  it("getImpactGraph builds reverse dependency map", () => {
    const graph = getImpactGraph(tokens);
    assert.ok(graph["color.primary"]);
    assert.ok(graph["color.primary"].includes("color.button.bg"));
  });

  it("getTransitiveDependents returns all transitive refs", () => {
    const tokensDeep = {
      color: {
        primary: { $value: "#3b82f6", $type: "color" },
        button: { bg: { $value: "{color.primary}", $type: "color" } },
        card: { bg: { $value: "{color.button.bg}", $type: "color" } },
      },
    };
    const deps = getTransitiveDependents(tokensDeep, "color.primary");
    assert.ok(deps.includes("color.button.bg"));
    assert.ok(deps.includes("color.card.bg"));
  });

  it("generateCodemod produces rename and update-ref ops", () => {
    const codemod = generateCodemod(tokens, { from: "color.primary", to: "color.brand.primary" });
    assert.equal(codemod.version, "1.0.0");
    assert.ok(codemod.operations.length >= 2);
    assert.equal(codemod.operations[0].type, "rename");
    assert.equal(codemod.operations[0].from, "color.primary");
    assert.equal(codemod.operations[0].to, "color.brand.primary");
    const refOp = codemod.operations.find((o) => o.type === "update-ref");
    assert.ok(refOp);
    assert.equal(refOp.path, "color.button.bg");
  });

  it("applyCodemod applies rename and ref updates", () => {
    const codemod = generateCodemod(tokens, { from: "color.primary", to: "color.brand.primary" });
    const { tree, changes } = applyCodemod(tokens, codemod);
    assert.ok(tree.color.brand);
    assert.equal(tree.color.brand.primary.$value, "#3b82f6");
    assert.equal(tree.color.button.bg.$value, "{color.brand.primary}");
    assert.ok(changes.length >= 2);
  });

  it("generateCSSCodemod produces find/replace pairs", () => {
    const registry = buildNameRegistry(tokens);
    const cssCodemod = generateCSSCodemod("", registry, { from: "color.primary", to: "color.brand.primary" });
    assert.equal(cssCodemod.type, "css");
    assert.equal(cssCodemod.operations.length, 1);
    assert.ok(cssCodemod.operations[0].find.includes("color"));
  });
});

// ============================================================
// Federation
// ============================================================

describe("v7: federation", () => {
  const teamA = { color: { primary: { $value: "#3b82f6", $type: "color" } } };
  const teamB = { spacing: { md: { $value: "16px", $type: "dimension" } } };

  function writeTeamTokens(name, tokens) {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "tokens.json");
    writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
    return path;
  }

  it("validateManifest validates a manifest object", () => {
    const pathA = writeTeamTokens("team-a", teamA);
    const pathB = writeTeamTokens("team-b", teamB);
    const manifest = validateManifest(
      {
        name: "test-org",
        version: "1.0.0",
        teams: {
          core: { path: `team-a/tokens.json`, priority: 0 },
          brand: { path: `team-b/tokens.json`, priority: 1 },
        },
      },
      join(tmpDir, "manifest.json")
    );
    assert.equal(manifest.name, "test-org");
    assert.equal(manifest.teams.core.priority, 0);
  });

  it("validateManifest throws on missing teams", () => {
    assert.throws(() => validateManifest({}), /teams/);
  });

  it("resolveOrgTree merges team trees by priority", () => {
    const pathA = writeTeamTokens("team-c", teamA);
    const pathB = writeTeamTokens("team-d", teamB);
    const manifest = validateManifest(
      {
        teams: {
          core: { path: `team-c/tokens.json`, priority: 0 },
          brand: { path: `team-d/tokens.json`, priority: 1 },
        },
      },
      join(tmpDir, "manifest.json")
    );
    const { merged } = resolveOrgTree(manifest);
    assert.ok(merged.color);
    assert.ok(merged.spacing);
  });

  it("mergeRegistries prefixes team names", () => {
    const regA = buildNameRegistry(teamA);
    const regB = buildNameRegistry(teamB);
    const merged = mergeRegistries({ teamA: regA, teamB: regB });
    const json = merged.toJSON();
    assert.ok(json.names.some((n) => n.canonical.startsWith("teamA:")));
    assert.ok(json.names.some((n) => n.canonical.startsWith("teamB:")));
  });

  it("merged registry canonicalOf returns prefixed name", () => {
    const regA = buildNameRegistry(teamA);
    const merged = mergeRegistries({ teamA: regA });
    const canonical = merged.canonicalOf(["color", "primary"]);
    assert.ok(canonical.startsWith("teamA:"));
  });

  it("merged registry pathOf returns team and path", () => {
    const regA = buildNameRegistry(teamA);
    const merged = mergeRegistries({ teamA: regA });
    const canonical = merged.canonicalOf(["color", "primary"]);
    const info = merged.pathOf(canonical);
    assert.equal(info.team, "teamA");
    assert.deepEqual(info.path, ["color", "primary"]);
  });
});

// ============================================================
// Namespaces
// ============================================================

describe("v7: namespaces", () => {
  it("createNamespacedAuth resolves team-scoped tokens", () => {
    const auth = createNamespacedAuth({
      tokens: {
        "admin-token": { scope: "write", teams: ["*"] },
        "core-token": { scope: "write", teams: ["core"] },
        "viewer-token": { scope: "read", teams: ["*"] },
      },
    });

    assert.equal(auth("admin-token", "core"), "write");
    assert.equal(auth("admin-token", "brand"), "write");
    assert.equal(auth("core-token", "core"), "write");
    assert.equal(auth("core-token", "brand"), null);
    assert.equal(auth("viewer-token", "core"), "read");
    assert.equal(auth("unknown-token"), null);
  });

  it("createFlatNamespacedAuth gives all teams access", () => {
    const auth = createFlatNamespacedAuth({
      "token-a": "read",
      "token-b": "write",
    });

    assert.equal(auth("token-a", "core"), "read");
    assert.equal(auth("token-b", "brand"), "write");
    assert.equal(auth("unknown"), null);
  });
});

// ============================================================
// Lint: deprecated-in-use
// ============================================================

describe("v7: lint deprecated-in-use", () => {
  it("warns when non-deprecated token references deprecated token", () => {
    const tokens = {
      color: {
        primary: { $value: "#3b82f6", $type: "color" },
        old: { $value: "#000", $type: "color", deprecated: true },
        button: { bg: { $value: "{color.old}", $type: "color" } },
      },
    };
    const { issues } = lintTokens(tokens);
    const depIssues = issues.filter((i) => i.rule === "deprecated-in-use");
    assert.ok(depIssues.length > 0);
    assert.ok(depIssues[0].message.includes("deprecated"));
  });

  it("does not warn when deprecated token references deprecated token", () => {
    const tokens = {
      color: {
        old: { $value: "#000", $type: "color", deprecated: true },
        old2: { $value: "{color.old}", $type: "color", deprecated: true },
      },
    };
    const { issues } = lintTokens(tokens);
    const depIssues = issues.filter((i) => i.rule === "deprecated-in-use");
    assert.equal(depIssues.length, 0);
  });
});

// ============================================================
// Schema: $version, deprecated, replacedBy fields
// ============================================================

describe("v7: schema extensions", () => {
  it("validates tokens with $version field", () => {
    const tokens = {
      color: { primary: { $value: "#3b82f6", $type: "color", $version: "1.0.0" } },
    };
    assert.ok(validateTokens(tokens));
  });

  it("validates tokens with deprecated and replacedBy", () => {
    const tokens = {
      color: {
        primary: { $value: "#3b82f6", $type: "color" },
        old: { $value: "#000", $type: "color", deprecated: true, replacedBy: "color.primary" },
      },
    };
    assert.ok(validateTokens(tokens));
  });
});

// ============================================================
// Provenance: deprecation warnings
// ============================================================

describe("v7: provenance deprecation warnings", () => {
  it("buildProvenance includes deprecation info", () => {
    const tokens = {
      color: {
        primary: { $value: "#3b82f6", $type: "color" },
        old: { $value: "#000", $type: "color", deprecated: true, replacedBy: "color.primary" },
      },
    };
    const html = buildProvenance(tokens);
    assert.ok(html.includes("deprecated"));
    assert.ok(html.includes("color.primary"));
  });
});

// ============================================================
// Serve: change-request endpoints
// ============================================================

describe("v7: serve change-requests", () => {
  it("POST /tokens creates change request in approval mode", async () => {
    const { createTokenServer } = await import("../src/serve.js");
    const tokens = { color: { primary: { $value: "#3b82f6", $type: "color" } } };
    const server = createTokenServer({ tokens, watch: false, approve: true });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color: { primary: "#ef4444" } }),
      });
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.ok(body.pending);
      assert.equal(body.cr.status, "pending");

      const listRes = await fetch(`http://localhost:${port}/change-requests`);
      const list = await listRes.json();
      assert.ok(Array.isArray(list));
      assert.ok(list.length > 0);
    } finally {
      server.closeAll();
      server.close();
    }
  });
});

// ============================================================
// CLI: migrate subcommand
// ============================================================

describe("v7: CLI migrate", () => {
  it("migrate --from --to --dry-run shows operations", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const tokensPath = join(tmpDir, "cli-migrate-tokens.json");
    writeFileSync(tokensPath, JSON.stringify({
      color: {
        primary: { $value: "#3b82f6", $type: "color" },
        button: { bg: { $value: "{color.primary}", $type: "color" } },
      },
    }));

    const projectRoot = join(import.meta.dirname, "..");
    const { execSync } = await import("node:child_process");
    const out = execSync(
      `node src/cli.js migrate "${tokensPath}" --from color.primary --to color.brand.primary --dry-run`,
      { cwd: projectRoot, encoding: "utf8" }
    );
    assert.ok(out.includes("rename"));
    assert.ok(out.includes("update ref"));
  });
});
