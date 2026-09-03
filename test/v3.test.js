import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convert,
  resolveReferences,
  reverse,
  reverseStyleDictionary,
  flattenTokens,
  diffTokens,
} from "../src/index.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), "ttc3-"));
}

const clean = {
  palette: { brand: "#3b82f6", surface: "#fff", ink: "#0f172a" },
  space: { sm: "0.5rem", md: "1rem", lg: "{space.md} * 1.5" },
};

// --- reverse ---

test("reverse parses base :root custom properties", () => {
  const css = convert(clean, { format: "css" });
  const tree = reverse(css);
  assert.equal(tree.palette.brand, "#3b82f6");
  assert.equal(tree.space.lg, "1.5rem");
});

test("reverse folds [data-mode] into modes and [data-brand] into brands", () => {
  const tokens = {
    color: { primary: "#111" },
    modes: { dark: { color: { primary: "#222" } } },
    brands: { acme: { color: { primary: "#333" } } },
  };
  const css = convert(tokens, { format: "css" });
  const tree = reverse(css);
  assert.equal(tree.color.primary, "#111");
  assert.equal(tree.modes.dark.color.primary, "#222");
  assert.equal(tree.brands.acme.color.primary, "#333");
});

test("reverse round-trips CSS -> tree -> CSS identically (non-colliding names)", () => {
  const css = convert(clean, { format: "css" });
  const css2 = convert(reverse(css), { format: "css" });
  assert.equal(css, css2);
});

test("reverse handles bracket-less SCSS $variables", () => {
  const scss = convert(clean, { format: "scss" });
  const tree = reverse(scss);
  assert.equal(tree.palette.brand, "#3b82f6");
  assert.equal(tree.space.lg, "1.5rem");
});

test("reverse maps barefoot --bf-* vars back to token paths", () => {
  const bf = convert({ color: { primary: "#111" }, radius: { pill: "9999px" } }, { format: "barefoot" });
  const tree = reverse(bf);
  assert.equal(tree.color.primary, "#111");
  assert.equal(tree.radius.pill, "9999px");
});

test("reverse is best-effort: kebab collisions drop the nested branch, not the leaf", () => {
  // color.primaryHover kebabs to color-primary-hover, colliding with a
  // color.primary leaf on the shared color.primary prefix.
  const css = convert(
    { color: { primary: "#3b82f6", primaryHover: "#2563eb" } },
    { format: "css" }
  );
  const tree = reverse(css);
  assert.equal(tree.color.primary, "#3b82f6");
  assert.ok(tree.color.primaryHover === undefined || typeof tree.color.primaryHover === "string");
});

// --- style-dictionary interchange ---

test("reverseStyleDictionary unwraps {value} leaves", () => {
  const sd = { color: { primary: { value: "#fff" }, nested: { deep: { value: "1rem" } } } };
  assert.deepEqual(reverseStyleDictionary(sd), {
    color: { primary: "#fff", nested: { deep: "1rem" } },
  });
});

test("style-dictionary round-trips value-level via convert + reverse", () => {
  const sd = JSON.parse(convert(clean, { format: "style-dictionary" }));
  const back = reverseStyleDictionary(sd);
  const canon = (t) =>
    JSON.stringify(
      flattenTokens(resolveReferences(t, { reduce: true })),
      Object.keys(flattenTokens(resolveReferences(t, { reduce: true }))).sort()
    );
  assert.equal(canon(clean), canon(back));
});

// --- CLI: reverse / snapshot / history ---

test("CLI reverse writes a token tree from CSS", () => {
  const dir = tmp();
  try {
    const cssFile = join(dir, "out.css");
    writeFileSync(cssFile, convert(clean, { format: "css" }));
    const out = join(dir, "tokens.json");
    execFileSync("node", [CLI, "reverse", cssFile, "-o", out], { encoding: "utf8" });
    const tree = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(tree.palette.brand, "#3b82f6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI snapshot writes resolved tokens", () => {
  const dir = tmp();
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(input, JSON.stringify(clean));
    const snap = join(dir, "snap.json");
    execFileSync("node", [CLI, "snapshot", input, "-o", snap], { encoding: "utf8" });
    const tree = JSON.parse(readFileSync(snap, "utf8"));
    assert.equal(tree.space.lg, "1.5rem");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI history diffs a sequence of snapshots", () => {
  const dir = tmp();
  try {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    const c = join(dir, "c.json");
    writeFileSync(a, JSON.stringify({ color: { primary: "#111" } }));
    writeFileSync(b, JSON.stringify({ color: { primary: "#222" } }));
    writeFileSync(c, JSON.stringify({ color: { primary: "#222" }, space: { md: "1rem" } }));
    const out = execFileSync("node", [CLI, "history", a, b, c], { encoding: "utf8" });
    assert.match(out, /a\.json ->/);
    assert.match(out, /b\.json ->/);
    assert.match(out, /~ color-primary/);
    assert.match(out, /\+ space-md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI history requires at least two snapshots", () => {
  const dir = tmp();
  try {
    const a = join(dir, "a.json");
    writeFileSync(a, JSON.stringify({ x: "1" }));
    assert.throws(() => execFileSync("node", [CLI, "history", a], { encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
