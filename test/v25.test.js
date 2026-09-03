import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lintTokens,
  checkContract,
  buildKit,
  buildKitCSS,
  buildThemeJS,
  buildBindings,
  buildPreviewHTML,
  buildDocsSite,
  buildExplorerHTML,
  convert,
} from "../src/index.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), "ttc25-"));
}

// --- lint ---

test("lint detects unused tokens", () => {
  const { issues } = lintTokens({
    color: { primary: "#111" },
    spacing: { md: "1rem" },
    gap: "{spacing.md}",
  });
  const unused = issues.filter((i) => i.rule === "unused").map((i) => i.path);
  assert.ok(unused.includes("color-primary"));
});

test("lint reports no unused when nothing is referenced", () => {
  const r = lintTokens({ a: "1", b: "2" });
  assert.equal(r.issues.filter((i) => i.rule === "unused").length, 0);
});

test("lint detects duplicate values", () => {
  const { issues } = lintTokens({ a: "#fff", b: "#fff" });
  assert.ok(issues.some((i) => i.rule === "duplicate-value"));
});

test("lint detects untyped and broken $type", () => {
  const untyped = lintTokens({ color: { primary: { $value: "#fff" } } });
  assert.ok(untyped.issues.some((i) => i.rule === "untyped"));
  const broken = lintTokens({ color: { primary: { $value: "#fff", $type: "nope" } } });
  assert.ok(broken.issues.some((i) => i.rule === "broken-type" && i.severity === "error"));
  const typed = lintTokens({ color: { primary: { $value: "#fff", $type: "color" } } });
  assert.equal(typed.issues.filter((i) => i.rule === "untyped" || i.rule === "broken-type").length, 0);
});

test("lint detects unknown references as errors", () => {
  const r = lintTokens({ a: "{missing}" });
  assert.ok(r.issues.some((i) => i.rule === "unknown-reference" && i.severity === "error"));
  assert.ok(r.errors > 0);
});

test("lint detects dangling and missing brand overrides", () => {
  const dangling = lintTokens({
    color: { primary: "#111" },
    brands: { acme: { color: { nope: "#222" } } },
  });
  assert.ok(dangling.issues.some((i) => i.rule === "dangling-brand-override"));
  const missing = lintTokens({
    color: { primary: "#111", secondary: "#222" },
    brands: { a: { color: { primary: "#333" } }, b: {} },
  });
  assert.ok(missing.issues.some((i) => i.rule === "missing-brand-override"));
});

// --- contracts ---

test("checkContract enforces required tokens", () => {
  const schema = {
    type: "object",
    properties: { color: { type: "object", properties: { primary: { type: "string" } }, required: ["primary"] } },
    required: ["color"],
  };
  assert.equal(checkContract({ color: { primary: "#111" } }, schema), true);
  assert.throws(() => checkContract({ color: {} }, schema), /required token "color\.primary"/);
  assert.throws(() => checkContract({}, schema), /missing required token "color"/);
});

// --- kit ---

test("buildKitCSS emits mode + brand + combo blocks", () => {
  const { css, modes, brands } = buildKitCSS({
    color: { primary: "#111" },
    modes: { dark: { color: { primary: "#222" } } },
    brands: { acme: { color: { primary: "#333" } } },
  });
  assert.deepEqual(modes, ["dark"]);
  assert.deepEqual(brands, ["acme"]);
  assert.match(css, /:root \{/);
  assert.match(css, /:root\[data-mode="dark"\]/);
  assert.match(css, /:root\[data-brand="acme"\]/);
  assert.match(css, /:root\[data-mode="dark"\]\[data-brand="acme"\]/);
});

test("buildThemeJS is ~1KB and flips data attributes", () => {
  const js = buildThemeJS();
  assert.ok(js.length < 2048, `theme.js is ${js.length} bytes, expected < 2KB`);
  assert.match(js, /dataset\.theme/);
  assert.match(js, /setTheme/);
});

test("buildBindings emits tokens.ts and tokens.js", () => {
  const { ts, js, names } = buildBindings({ color: { primary: "#111" } });
  assert.ok(names.includes("color-primary"));
  assert.match(ts, /TokenName/);
  assert.match(ts, /colorPrimary/);
  assert.match(js, /export const tokens/);
  assert.match(js, /colorPrimary/);
});

test("buildPreviewHTML is self-contained with switchers", () => {
  const html = buildPreviewHTML({
    color: { primary: "#111" },
    modes: { dark: { color: { primary: "#222" } } },
    brands: { acme: { color: { primary: "#333" } } },
  });
  assert.match(html, /ttc-mode/);
  assert.match(html, /ttc-brand/);
  assert.match(html, /setTheme/);
  assert.match(html, /--color-primary/);
});

test("buildKit returns every artifact", () => {
  const kit = buildKit({ color: { primary: "#111" } });
  assert.match(kit.css, /--color-primary/);
  assert.ok(kit.js.length > 0);
  assert.match(kit.html, /<!doctype html>/);
  assert.match(kit.ts, /TokenName/);
  assert.match(kit.jsBindings, /export const tokens/);
});

// --- docs / explorer ---

test("buildDocsSite is searchable and lists tokens", () => {
  const html = buildDocsSite({ color: { primary: "#111" } });
  assert.match(html, /Search tokens/);
  assert.match(html, /color\.primary/);
  assert.match(html, /--color-primary/);
});

test("buildExplorerHTML has copy buttons", () => {
  const html = buildExplorerHTML({ color: { primary: "#111" } });
  assert.match(html, /data-copy/);
  assert.match(html, /clipboard/);
  assert.match(html, /--color-primary/);
});

test("convert supports docs/ts/js formats", () => {
  const tokens = { color: { primary: "#111" } };
  assert.match(convert(tokens, { format: "docs" }), /Search tokens/);
  assert.match(convert(tokens, { format: "ts" }), /TokenName/);
  assert.match(convert(tokens, { format: "js" }), /export const tokens/);
});

// --- CLI: kit ---

test("CLI kit emits a theme package", () => {
  const dir = tmp();
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(
      input,
      JSON.stringify({
        color: { primary: "#111" },
        modes: { dark: { color: { primary: "#222" } } },
        brands: { acme: { color: { primary: "#333" } } },
      })
    );
    const outDir = join(dir, "dist");
    execFileSync("node", [CLI, "kit", input, "--out-dir", outDir], { encoding: "utf8" });
    for (const f of ["theme.css", "theme.js", "tokens.ts", "tokens.js", "index.html"]) {
      assert.ok(existsSync(join(outDir, f)), `missing ${f}`);
    }
    assert.match(readFileSync(join(outDir, "theme.css"), "utf8"), /data-mode="dark"/);
    assert.match(readFileSync(join(outDir, "theme.css"), "utf8"), /data-brand="acme"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI: lint ---

test("CLI lint passes clean tokens and fails on errors", () => {
  const dir = tmp();
  try {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ color: { primary: "#111" } }));
    execFileSync("node", [CLI, "lint", good], { encoding: "utf8" });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ a: "{missing}" }));
    assert.throws(() => execFileSync("node", [CLI, "lint", bad], { encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI lint --json prints structured issues", () => {
  const dir = tmp();
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(input, JSON.stringify({ a: "1", b: "1" }));
    const out = execFileSync("node", [CLI, "lint", input, "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.issues));
    assert.ok(parsed.issues.some((i) => i.rule === "duplicate-value"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI: --check ---

test("CLI --check passes when up to date and fails when stale", () => {
  const dir = tmp();
  try {
    const input = join(dir, "tokens.json");
    const out = join(dir, "out.css");
    writeFileSync(input, JSON.stringify({ color: { primary: "#111" } }));
    execFileSync("node", [CLI, input, "-o", out], { encoding: "utf8" });
    execFileSync("node", [CLI, input, "-o", out, "--check"], { encoding: "utf8" });
    writeFileSync(input, JSON.stringify({ color: { primary: "#222" } }));
    assert.throws(() => execFileSync("node", [CLI, input, "-o", out, "--check"], { encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --contract enforces required tokens", () => {
  const dir = tmp();
  try {
    const input = join(dir, "tokens.json");
    const contract = join(dir, "contract.json");
    writeFileSync(input, JSON.stringify({ color: {} }));
    writeFileSync(
      contract,
      JSON.stringify({
        type: "object",
        properties: {
          color: { type: "object", properties: { primary: { type: "string" } }, required: ["primary"] },
        },
        required: ["color"],
      })
    );
    assert.throws(() => execFileSync("node", [CLI, input, "--contract", contract], { encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
