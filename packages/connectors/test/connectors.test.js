import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as conn from "@token-to-css/connectors";
import {
  registerConnector,
  getConnector,
  listConnectors,
  connectorPull,
  connectorPush,
  toTransportTree,
  registerFigmaConnector,
  tokensToFigmaVariables,
  figmaVariablesToTokens,
  registerStorybookConnector,
  tokensToStorybookTheme,
  storybookThemeToTokens,
  registerGithubPrConnector,
  tokensToGithubFiles,
  githubFilesToTokens,
  registerCmsConnector,
  tokensToCmsEntries,
  cmsEntriesToTokens,
} from "@token-to-css/connectors";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const FORBIDDEN = [
  'from "token-to-css"',
  "from 'token-to-css'",
  "./serve.js",
  "./editor.js",
  "./mcp.js",
  "./relay.js",
  "./adopt.js",
  "./cli.js",
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

const tokens = {
  color: { primary: "#3b82f6", secondary: "#22c55e", background: "#ffffff", text: "#111111" },
  space: { md: "1rem" },
};

test("connector hub SDK is exported and works", () => {
  for (const [name, fn] of Object.entries({
    registerConnector, getConnector, listConnectors, connectorPull,
    connectorPush, toTransportTree,
  })) {
    assert.equal(typeof fn, "function", `missing ${name}`);
  }
  const probe = {
    name: "probe-" + Date.now(),
    pull: async () => tokens,
    push: async () => {},
  };
  registerConnector(probe);
  assert.ok(getConnector(probe.name));
  assert.ok(listConnectors().includes(probe.name));
});

test("connectors depend only on @token-to-css/core (no meta/serve/editor imports)", () => {
  for (const f of walk(srcDir)) {
    const rel = f.slice(srcDir.length + 1).replace(/\\/g, "/");
    const src = readFileSync(f, "utf8");
    for (const bad of FORBIDDEN) {
      assert.ok(!src.includes(bad), `connector file ${rel} must not import ${bad}`);
    }
  }
});

test("Figma connector round-trips tokens to variables and back", () => {
  const doc = tokensToFigmaVariables(tokens);
  assert.ok(doc.collections && doc.collections[0].variables.length >= 2);
  const back = figmaVariablesToTokens(doc);
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
  registerFigmaConnector({});
  assert.ok(getConnector("figma") === undefined, "figma is a plugin format, not a hub connector");
});

test("Storybook connector round-trips tokens to a theme and back", () => {
  const doc = tokensToStorybookTheme(tokens);
  assert.equal(doc.theme.colorPrimary, "#3b82f6");
  const back = storybookThemeToTokens(doc);
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
  registerStorybookConnector({});
  assert.ok(getConnector("storybook"));
});

test("GitHub connector round-trips tokens to files and back", () => {
  const files = tokensToGithubFiles(tokens, { path: "tokens.json" });
  assert.ok(files["tokens.json"].includes('"primary"'));
  const back = githubFilesToTokens(files, { path: "tokens.json" });
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
  registerGithubPrConnector({});
  assert.ok(getConnector("github"));
});

test("CMS connector round-trips tokens to entries and back", () => {
  const entries = tokensToCmsEntries(tokens);
  const primary = entries.find((e) => e.id === "color.primary");
  assert.equal(primary.fields.value, "#3b82f6");
  const back = cmsEntriesToTokens(entries);
  assert.equal(JSON.stringify(back), JSON.stringify(tokens));
  registerCmsConnector({});
  assert.ok(getConnector("cms"));
});

test("every connector export resolves through the package boundary", () => {
  const surface = [
    "registerConnector", "getConnector", "listConnectors", "connectorPull",
    "connectorPush", "toTransportTree", "registerFigmaConnector",
    "tokensToFigmaVariables", "figmaVariablesToTokens",
    "registerStorybookConnector", "tokensToStorybookTheme",
    "storybookThemeToTokens", "registerGithubPrConnector",
    "tokensToGithubFiles", "githubFilesToTokens", "registerCmsConnector",
    "tokensToCmsEntries", "cmsEntriesToTokens",
  ];
  for (const name of surface) {
    assert.ok(typeof conn[name] === "function", `missing connector export: ${name}`);
  }
});
