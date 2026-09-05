import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  validateManifest,
  resolveOrgTree,
  listPackageVersions,
  resolvePackage,
  mergeOrgRegistries,
  validateFederatedManifest,
  resolveFederatedTree,
  analyzeCrossOrgLock,
  createOrgAuth,
  orgRoomKey,
  createTokenServer,
  buildNameRegistry,
} from "../src/index.js";
import { handleRelayPost } from "../src/relay.js";
import { createChangeRequest, approveChangeRequest, applyChangeRequest } from "../src/governance.js";

// ============================================================
// Published token packages
// ============================================================

describe("v11: published token packages", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ttc-v11-pkg-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRelease(pkgDir, version, tree) {
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, `${version}.json`), JSON.stringify(tree, null, 2), "utf8");
  }

  test("listPackageVersions lists semver-sorted versions", () => {
    const pkgDir = join(dir, "acme-tokens");
    writeRelease(pkgDir, "2.0.0", { color: { primary: "#111" } });
    writeRelease(pkgDir, "1.5.0", { color: { primary: "#000" } });
    writeRelease(pkgDir, "2.1.0", { color: { primary: "#222" } });
    const versions = listPackageVersions(dir, "acme-tokens");
    assert.deepEqual(versions, ["1.5.0", "2.0.0", "2.1.0"]);
  });

  test("resolvePackage picks the newest in-range release", () => {
    const manifest = validateManifest(
      {
        name: "my-org",
        packages: { "@acme/tokens": "acme-tokens" },
        teams: { local: { path: "noop.json" } },
      },
      join(dir, "manifest.json")
    );
    const pkg = resolvePackage({ package: "@acme/tokens", range: "^2.0" }, {
      packages: manifest.packages,
    });
    assert.equal(pkg.version, "2.1.0");
    assert.equal(pkg.tree.color.primary, "#222");
  });

  test("resolvePackage throws when no version satisfies the range", () => {
    const manifest = validateManifest(
      {
        name: "my-org",
        packages: { "@acme/tokens": "acme-tokens" },
        teams: { local: { path: "noop.json" } },
      },
      join(dir, "manifest.json")
    );
    assert.throws(
      () => resolvePackage({ package: "@acme/tokens", range: "^3.0" }, { packages: manifest.packages }),
      /no version/
    );
  });

  test("org manifest resolves a remote package team by semver range", () => {
    const pkgDir = join(dir, "acme-tokens-2");
    writeRelease(pkgDir, "2.0.0", { color: { primary: "#111" } });
    writeRelease(pkgDir, "3.0.0", { color: { primary: "#333", brand: "#444" } });
    const manifest = validateManifest(
      {
        name: "my-org",
        packages: { "@acme/tokens": "acme-tokens-2" },
        teams: {
          acme: { org: "acme", package: "@acme/tokens", range: "^2.0" },
        },
      },
      join(dir, "manifest2.json")
    );
    // ^2.0 must NOT pick 3.0.0
    assert.equal(listPackageVersions(dir, "acme-tokens-2").length, 2);
    const { merged, origins, resolvedPackages } = resolveOrgTree(manifest);
    assert.equal(merged.color.primary, "#111");
    assert.equal(resolvedPackages.acme.version, "2.0.0");
    assert.equal(origins["color.primary"].org, "acme");
  });

  test("remote package teams default to priority -1 and lose to local", () => {
    const pkgDir = join(dir, "acme-tokens-3");
    writeRelease(pkgDir, "1.0.0", { color: { primary: "#remote" } });
    const localPath = join(dir, "local.json");
    writeFileSync(localPath, JSON.stringify({ color: { primary: "#local" } }), "utf8");
    const manifest = validateManifest(
      {
        name: "my-org",
        packages: { "@acme/tokens": "acme-tokens-3" },
        teams: {
          acme: { org: "acme", package: "@acme/tokens", range: "*" },
          local: { path: "local.json", priority: 0 },
        },
      },
      join(dir, "manifest3.json")
    );
    const { merged, origins } = resolveOrgTree(manifest);
    assert.equal(merged.color.primary, "#local");
    assert.equal(origins["color.primary"].org, "my-org");
  });

  test("validateManifest rejects a remote team without org", () => {
    assert.throws(
      () =>
        validateManifest({
          teams: { bad: { package: "@acme/tokens" } },
        }),
      /org/
    );
  });
});

// ============================================================
// Federated manifest + org-segmented registries
// ============================================================

describe("v11: federated manifest", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ttc-v11-fed-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves two orgs' published package by semver range and merges with priority rules", () => {
    // org A publishes @acme/tokens 2.x; consumer org B references it.
    const pkgDir = join(dir, "acme-tokens");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "2.3.0.json"),
      JSON.stringify({ color: { primary: "#acme", accent: "#eee" } }),
      "utf8"
    );
    writeFileSync(
      join(pkgDir, "3.0.0.json"),
      JSON.stringify({ color: { primary: "#acme3" } }),
      "utf8"
    );
    const localPath = join(dir, "b-tokens.json");
    writeFileSync(
      localPath,
      JSON.stringify({ color: { primary: "#b-local" } }),
      "utf8"
    );
    const fed = validateFederatedManifest(
      {
        name: "alliance",
        orgs: {
          acme: {
            teams: {
              pub: { package: "@acme/tokens", org: "acme", range: "^2.0" },
            },
            packages: { "@acme/tokens": "acme-tokens" },
          },
          globex: {
            teams: { core: { path: localPath, priority: 2 } },
          },
        },
      },
      join(dir, "fed.manifest.json")
    );
    const { merged, orgTrees, origins } = resolveFederatedTree(fed);
    assert.equal(orgTrees.acme.resolvedPackages.pub.version, "2.3.0");
    assert.equal(merged.color.primary, "#b-local", "local org wins over remote");
    assert.equal(origins["color.primary"].org, "globex");
    assert.equal(origins["color.accent"].org, "acme");
  });

  test("validateFederatedManifest throws without orgs", () => {
    assert.throws(() => validateFederatedManifest({}), /orgs/);
  });
});

describe("v11: mergeOrgRegistries (org:team:canonical)", () => {
  test("two orgs with identical token names keep distinct canonicals", () => {
    const tokensA = { color: { primary: "#111", primaryHover: "#222" } };
    const tokensB = { color: { primary: "#333" } };
    const regA = buildNameRegistry(tokensA);
    const regB = buildNameRegistry(tokensB);
    const fed = mergeOrgRegistries({
      acme: { core: regA },
      globex: { core: regB },
    });
    const cA = fed.canonicalOf("acme", ["color", "primary"]);
    const cB = fed.canonicalOf("globex", ["color", "primary"]);
    assert.equal(cA, "acme:core:color-primary");
    assert.equal(cB, "globex:core:color-primary");
    assert.notEqual(cA, cB);

    // lossless round-trip through pathOf even on collisions
    assert.deepEqual(fed.pathOf(cA), ["acme", "color", "primary"]);
    assert.deepEqual(fed.pathOf(cB), ["globex", "color", "primary"]);
    assert.deepEqual(fed.ownerOf(cA), { org: "acme", team: "core" });

    const json = fed.toJSON();
    assert.equal(json.version, 2);
    assert.ok(json.names.every((n) => /^[^:]+:[^:]+:/.test(n.canonical)));
  });

  test("plain-path canonicalOf finds a unique path across orgs", () => {
    const tokens = { color: { primary: "#111" } };
    const fed = mergeOrgRegistries({ acme: { core: buildNameRegistry(tokens) } });
    assert.equal(fed.canonicalOf(["color", "primary"]), "acme:core:color-primary");
  });

  test("round-trips a kebab-colliding pair losslessly across orgs", () => {
    const tokens = { color: { primary: "#1", primaryHover: "#2" } };
    const fed = mergeOrgRegistries({
      acme: { core: buildNameRegistry(tokens) },
      globex: { core: buildNameRegistry(tokens) },
    });
    for (const org of ["acme", "globex"]) {
      const c1 = fed.canonicalOf(org, ["color", "primary"]);
      const c2 = fed.canonicalOf(org, ["color", "primaryHover"]);
      assert.deepEqual(fed.pathOf(c1), [org, "color", "primary"]);
      assert.deepEqual(fed.pathOf(c2), [org, "color", "primaryHover"]);
    }
  });
});

// ============================================================
// Cross-org lockfile + breaking alerts
// ============================================================

describe("v11: cross-org lockfiles", () => {
  let dir;
  let pkgDir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ttc-v11-lock-"));
    pkgDir = join(dir, "acme-tokens");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "2.3.0.json"),
      JSON.stringify({ color: { primary: "#111", old: "#000" }, space: { md: "1rem" } }),
      "utf8"
    );
    writeFileSync(
      join(pkgDir, "3.0.0.json"),
      JSON.stringify({ color: { primary: "#2563eb" }, space: { md: "1rem" } }),
      "utf8"
    );
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a ^2.x consumer fails against a cross-org 3.0 release, listing every affected usage", () => {
    const lock = {
      name: "consumer-app",
      package: "@acme/tokens",
      range: "^2.3",
      uses: ["color.old", "color.primary", "space.md"],
    };
    const res = analyzeCrossOrgLock(lock, pkgDir);
    assert.equal(res.package, "@acme/tokens");
    assert.equal(res.prevVersion, "2.3.0");
    assert.equal(res.nextVersion, "3.0.0");
    assert.equal(res.inRange, false);
    assert.equal(res.ok, false);
    const paths = res.breaking.map((b) => b.path);
    assert.ok(paths.includes("color-old"));
    assert.ok(paths.includes("color-primary"));
    assert.ok(!paths.includes("space-md"));
  });

  test("an in-range consumer with no removals passes", () => {
    const res = analyzeCrossOrgLock(
      { package: "@acme/tokens", range: "^2.3", version: "2.3.0", uses: ["space.md"] },
      pkgDir,
      { nextVersion: "2.3.0" }
    );
    assert.equal(res.inRange, true);
    assert.equal(res.ok, true);
    assert.equal(res.breaking.length, 0);
  });

  test("throws when the package directory has no releases", () => {
    assert.throws(() => analyzeCrossOrgLock({ package: "x", range: "*" }, join(dir, "nope")), /no published versions/);
  });
});

// ============================================================
// Org rooms & trust
// ============================================================

describe("v11: org auth", () => {
  const auth = createOrgAuth({
    tokens: {
      "acme-write": { scope: "write", org: "acme", teams: ["*"] },
      "globex-view": { scope: "read", org: "globex", teams: ["web"] },
    },
  });

  test("org A's write token is null on org B's server", () => {
    assert.equal(auth("acme-write", "acme"), "write");
    assert.equal(auth("acme-write", "globex"), null);
    assert.equal(auth("globex-view", "globex"), "read");
    assert.equal(auth("globex-view", "globex", "web"), "read");
    assert.equal(auth("globex-view", "globex", "billing"), null);
  });

  test("orgRoomKey formats (org, team) rooms", () => {
    assert.equal(orgRoomKey("acme"), "acme");
    assert.equal(orgRoomKey("acme", "web"), "acme/web");
  });
});

// ============================================================
// Server-to-server relay (change-request flow)
// ============================================================

test("reverse(convert(federated tree, { registry })) reproduces every org's tokens byte-for-byte", async () => {
  const { convert, reverse } = await import("../src/index.js");
  const tokensA = { color: { primary: "#111", primaryHover: "#222" } };
  const tokensB = { color: { primary: "#333", primaryHover: "#444" } };
  const fed = mergeOrgRegistries({
    acme: { core: buildNameRegistry(tokensA) },
    globex: { core: buildNameRegistry(tokensB) },
  });
  const federated = { acme: tokensA, globex: tokensB };
  const css = convert(federated, { registry: fed });
  assert.ok(css.includes("--acme:core:color-primary"));
  assert.ok(css.includes("--globex:core:color-primary"));
  const back = reverse(css, { registry: fed });
  assert.deepEqual(back, federated);
});

describe("v11: relay", () => {
  test("handleRelayPost creates a pending CR, never writes source", () => {
    const sourceTree = { color: { primary: "#local" } };
    const changeRequests = [];
    let broadcastEvents = [];
    const state = {
      sourceTree,
      changeRequests,
      broadcast: (e) => broadcastEvents.push(e),
    };
    const remote = { color: { primary: "#remote" } };
    const r1 = handleRelayPost(state, "https://acme.example", remote);
    assert.equal(r1.pending, true);
    assert.equal(changeRequests.length, 1);
    assert.equal(changeRequests[0].status, "pending");
    assert.equal(changeRequests[0].origin, "https://acme.example");
    assert.equal(changeRequests[0].author, "relay:https://acme.example");
    assert.equal(sourceTree.color.primary, "#local", "source untouched");
    assert.equal(broadcastEvents.length, 1);

    // Idempotent: same tree again -> noop, no second CR
    const r2 = handleRelayPost(state, "https://acme.example", remote);
    assert.equal(r2.noop, true);
    assert.equal(changeRequests.length, 1);

    // approving folds it into local source by local policy
    const cr = changeRequests[0];
    approveChangeRequest(cr);
    const { tree } = applyChangeRequest(sourceTree, cr);
    assert.equal(tree.color.primary, "#remote");
  });

  test("relayChange pulls org A's tree and lands it at org B as a pending CR", async () => {
    const serverA = createTokenServer({
      tokens: { color: { primary: "#aaa" } },
      watch: false,
      port: 0,
      org: "a",
    });
    const serverB = createTokenServer({
      tokens: { color: { primary: "#bbb" } },
      watch: false,
      port: 0,
      org: "b",
    });
    await new Promise((resolve) => serverA.listen(0, resolve));
    await new Promise((resolve) => serverB.listen(0, resolve));
    const { relayChange } = await import("../src/relay.js");
    try {
      const result = await relayChange({
        fromUrl: `http://localhost:${serverA.address().port}`,
        toUrl: `http://localhost:${serverB.address().port}`,
        origin: "org-a",
      });
      assert.equal(result.status, 200);
      assert.equal(result.pending, true);
      assert.equal(result.cr.origin, "org-a");
      const crs = await (
        await fetch(`http://localhost:${serverB.address().port}/change-requests`)
      ).json();
      assert.equal(crs.length, 1);
      assert.equal(crs[0].author, "relay:org-a");
    } finally {
      serverA.closeAll();
      serverB.closeAll();
      serverA.close();
      serverB.close();
    }
  });

  test("end-to-end: two serve instances; org A edit arrives at org B as a pending CR; approving folds it in; declining leaves B untouched", async () => {
    const tokensA = { color: { primary: "#aaa" } };
    const tokensB = { color: { primary: "#bbb" } };
    const serverA = createTokenServer({ tokens: tokensA, watch: false, port: 0 });
    const serverB = createTokenServer({ tokens: tokensB, watch: false, port: 0 });
    await new Promise((resolve) => serverA.listen(0, resolve));
    await new Promise((resolve) => serverB.listen(0, resolve));
    const portA = serverA.address().port;
    const portB = serverB.address().port;

    try {
      // org B relays org A's tree in
      const res = await fetch(`http://localhost:${portB}/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: `http://localhost:${portA}`,
          tree: { color: { primary: "#relay-from-a" } },
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.pending, true);

      // B's source untouched; CR pending
      const crs = await (await fetch(`http://localhost:${portB}/change-requests`)).json();
      assert.equal(crs.length, 1);
      assert.equal(crs[0].status, "pending");
      const bTree = await (await fetch(`http://localhost:${portB}/tokens`)).json();
      assert.equal(bTree.color.primary, "#bbb");

      // decline -> B untouched
      const rej = await fetch(`http://localhost:${portB}/change-requests/${crs[0].id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: "not now" }),
      });
      assert.equal(rej.status, 200);

      // second relay -> new CR; approve -> folded in
      await fetch(`http://localhost:${portB}/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: `http://localhost:${portA}`,
          tree: { color: { primary: "#approved-change" } },
        }),
      });
      const crs2 = await (await fetch(`http://localhost:${portB}/change-requests`)).json();
      const pending = crs2.find((c) => c.status === "pending");
      assert.ok(pending, "a pending CR exists");
      const appr = await fetch(`http://localhost:${portB}/change-requests/${pending.id}/approve`, { method: "POST" });
      assert.equal(appr.status, 200);
      const bTree2 = await (await fetch(`http://localhost:${portB}/tokens`)).json();
      assert.equal(bTree2.color.primary, "#approved-change");
    } finally {
      serverA.closeAll();
      serverB.closeAll();
      serverA.close();
      serverB.close();
    }
  });

  test("org trust: org A's write token cannot mutate org B's source (403)", async () => {
    const auth = createOrgAuth({
      tokens: {
        "a-write": { scope: "write", org: "a", teams: ["*"] },
        "b-write": { scope: "write", org: "b", teams: ["*"] },
      },
    });
    const serverB = createTokenServer({
      tokens: { color: { primary: "#b" } },
      watch: false,
      port: 0,
      org: "b",
      auth,
    });
    await new Promise((resolve) => serverB.listen(0, resolve));
    const portB = serverB.address().port;
    try {
      // foreign org write -> 403
      const bad = await fetch(`http://localhost:${portB}/tokens`, {
        method: "POST",
        headers: {
          authorization: "Bearer a-write",
          "content-type": "application/json",
        },
        body: JSON.stringify({ color: { primary: "#evil" } }),
      });
      assert.equal(bad.status, 403);

      // own org write -> 200
      const good = await fetch(`http://localhost:${portB}/tokens`, {
        method: "POST",
        headers: {
          authorization: "Bearer b-write",
          "content-type": "application/json",
        },
        body: JSON.stringify({ color: { primary: "#b2" } }),
      });
      assert.equal(good.status, 200);
      const tree = await (
        await fetch(`http://localhost:${portB}/tokens`, {
          headers: { authorization: "Bearer b-write" },
        })
      ).json();
      assert.equal(tree.color.primary, "#b2");
    } finally {
      serverB.closeAll();
      serverB.close();
    }
  });

  test("provenance records the org of origin for merged tokens", () => {
    // covered in package tests above via resolveOrgTree origins; assert shape once more
    const dir = mkdtempSync(join(tmpdir(), "ttc-v11-prov-"));
    try {
      const a = join(dir, "a.json");
      writeFileSync(a, JSON.stringify({ color: { primary: "#a" } }), "utf8");
      const b = join(dir, "b.json");
      writeFileSync(b, JSON.stringify({ color: { secondary: "#b" } }), "utf8");
      const manifest = validateManifest(
        { name: "org-a", teams: { core: { path: "a.json" }, web: { path: "b.json", priority: 1 } } },
        join(dir, "m.json")
      );
      const { origins } = resolveOrgTree(manifest);
      assert.deepEqual(origins["color.primary"], { org: "org-a", team: "core" });
      assert.deepEqual(origins["color.secondary"], { org: "org-a", team: "web" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Cross-org adoption rollup
// ============================================================

test("computeFederatedAdoption rolls up per org across the mesh", async () => {
  const { computeFederatedAdoption } = await import("../src/index.js");
  const orgTeamTrees = {
    acme: { core: { color: { primary: "#3b82f6" } } },
    globex: { web: { color: { primary: "#3b82f6" } } },
  };
  const sourcesByOrg = {
    acme: { core: [{ file: "a.css", text: ".x { color: var(--color-primary); }" }] },
    globex: { web: [{ file: "b.css", text: ".y { color: #3b82f6; }" }] },
  };
  const { orgs, combined } = computeFederatedAdoption(orgTeamTrees, sourcesByOrg);
  assert.equal(orgs.acme.org.score, 100);
  assert.ok(orgs.globex.org.score < 100);
  assert.ok(combined.score > 0 && combined.score < 100);
  assert.equal(combined.adopted, 1);
  assert.equal(combined.hardcoded, 1);
});
