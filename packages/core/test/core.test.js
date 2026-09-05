import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as core from "@token-to-css/core";
import { buildNameRegistry } from "@token-to-css/core";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const FORBIDDEN = [
  '@token-to-css/connectors',
  "./serve.js",
  "./editor.js",
  "./mcp.js",
  "./relay.js",
  "./adopt.js",
  "./cli.js",
  "./connectors/",
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

test("core exposes the compiler surface (roadmap v11.5)", () => {
  const surface = [
    "convert", "convertToMap", "flattenTokens", "normalizeW3C", "applyMap",
    "toCSS", "toSCSS", "toCSSModules", "toBarefoot", "resolveReferences",
    "registerFunction", "registerFormat", "registerPlugin", "validateTokens",
    "TokenValidationError", "lintTokens", "checkContract", "buildNameRegistry",
    "registryFromJSON", "setByPath", "getByPath", "mergeRegistries", "reverse",
    "reverseStyleDictionary", "applyReversedIntoSource", "computeDrift",
    "canSetPath", "parseLocated", "buildClientJS", "addVersionMarkers",
    "getDeprecations", "createChangeRequest", "approveChangeRequest",
    "rejectChangeRequest", "applyChangeRequest", "getImpactGraph",
    "getTransitiveDependents", "generateCodemod", "applyCodemod",
    "generateCSSCodemod", "buildOrgManifest", "validateManifest",
    "resolveOrgTree", "lintOrg", "listPackageVersions", "resolvePackage",
    "mergeOrgRegistries", "buildFederatedManifest", "validateFederatedManifest",
    "resolveFederatedTree", "analyzeCrossOrgLock", "createNamespacedAuth",
    "createFlatNamespacedAuth", "createNamespacedMiddleware", "createOrgAuth",
    "orgRoomKey", "bumpVersion", "classifyRelease", "generateChangelog",
    "release", "semverSatisfies", "analyzeLockfile", "bisectToken",
    "renderSideBySide", "diffTokens", "buildSourceMap", "parseColor",
    "formatColor", "mix", "withAlpha", "lighten", "darken", "buildKit",
    "buildKitCSS", "buildThemeJS", "buildBindings", "buildPreviewHTML",
    "splitThemes", "buildDocsSite", "buildExplorerHTML", "buildProvenance",
  ];
  for (const name of surface) {
    assert.ok(typeof core[name] === "function", `missing core export: ${name}`);
  }
});

test("core round-trips colliding token names losslessly (registry)", () => {
  const tokens = {
    color: {
      primary: "#3b82f6",
      primaryHover: "#2563eb",
      bg: "white",
    },
  };
  const registry = buildNameRegistry(tokens);
  const css = core.convert(tokens, { registry });
  const back = core.reverse(css, { registry });
  assert.deepEqual(back, tokens);
});

test("core converts tokens to CSS custom properties", () => {
  const css = core.convert({ color: { primary: "#3b82f6" } });
  assert.match(css, /--color-primary: #3b82f6/);
});

test("core ships NO connector / serve / editor file (package boundary)", () => {
  const files = walk(srcDir);
  for (const f of files) {
    const rel = f.slice(srcDir.length + 1).replace(/\\/g, "/");
    assert.ok(
      !/(^|\/)(serve|editor|mcp|relay|adopt|cli|connect)\.js$/.test(rel),
      `core must not contain ${rel}`
    );
    const src = readFileSync(f, "utf8");
    for (const bad of FORBIDDEN) {
      assert.ok(
        !src.includes(`from "${bad}"`) && !src.includes(`from '${bad}'`),
        `core file ${rel} must not import ${bad}`
      );
    }
  }
});
