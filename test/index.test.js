import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenTokens,
  toCSS,
  toSCSS,
  toBarefoot,
  convert,
} from "../src/index.js";
import { resolveReferences } from "../src/references.js";
import { validateTokens, TokenValidationError } from "../src/schema.js";

test("flattenTokens flattens nested objects with kebab-case keys", () => {
  const flat = flattenTokens({
    color: { primary: "#3b82f6", primaryHover: "#2563eb" },
    font: { size: { lg: "1.25rem" } },
  });
  assert.deepEqual(flat, {
    "color-primary": "#3b82f6",
    "color-primary-hover": "#2563eb",
    "font-size-lg": "1.25rem",
  });
});

test("flattenTokens ignores null and undefined", () => {
  const flat = flattenTokens({ a: null, b: undefined, c: "x" });
  assert.deepEqual(flat, { c: "x" });
});

test("toCSS emits CSS custom properties", () => {
  const css = toCSS({ "color-primary": "#3b82f6" });
  assert.match(css, /:root \{/);
  assert.match(css, /--color-primary: #3b82f6;/);
});

test("toCSS honors a custom selector", () => {
  const css = toCSS({ x: "1" }, { selector: ".theme" });
  assert.match(css, /\.theme \{/);
});

test("toSCSS emits SCSS variables", () => {
  const scss = toSCSS({ "color-primary": "#3b82f6" });
  assert.match(scss, /\$color-primary: #3b82f6;/);
});

test("convert dispatches formats", () => {
  const tokens = { color: { primary: "#000" } };
  assert.match(convert(tokens, { format: "scss" }), /\$color-primary/);
  assert.match(convert(tokens, { format: "css" }), /--color-primary/);
});

test("toBarefoot maps semantic tokens to --bf-* names", () => {
  const flat = flattenTokens({
    color: { primary: "#3b82f6", background: "#fff", text: "#111" },
    radius: { md: "0.375rem", sm: "0.25rem" },
    spacing: { 4: "1rem" },
  });
  const css = toBarefoot(flat);
  assert.match(css, /--bf-primary: #3b82f6;/);
  assert.match(css, /--bf-surface: #fff;/);
  assert.match(css, /--bf-text: #111;/);
  assert.match(css, /--bf-radius-sm: 0.25rem;/);
  assert.match(css, /--bf-space-4: 1rem;/);
});

test("toBarefoot wraps in a data-bf-theme selector when given a theme", () => {
  const flat = flattenTokens({ color: { primary: "#000" } });
  const css = toBarefoot(flat, { theme: "brand" });
  assert.match(css, /\[data-bf-theme="brand"\] \{/);
});

test("toBarefoot applies a custom map that overrides the built-in one", () => {
  const flat = flattenTokens({
    brand: "#3b82f6",
    canvas: "#fff",
    weirdName: "keep-me",
  });
  const css = toBarefoot(flat, {
    map: { brand: "--bf-primary", canvas: "--bf-surface" },
  });
  assert.match(css, /--bf-primary: #3b82f6;/);
  assert.match(css, /--bf-surface: #fff;/);
  assert.doesNotMatch(css, /--bf-brand:/);
  assert.doesNotMatch(css, /--bf-canvas:/);
});

test("resolveReferences substitutes {dotted.path} tokens", () => {
  const resolved = resolveReferences({
    spacing: { md: "1rem" },
    gap: "{spacing.md}",
  });
  assert.equal(resolved.gap, "1rem");
});

test("resolveReferences wraps spaced arithmetic in calc()", () => {
  const resolved = resolveReferences({
    spacing: { md: "1rem" },
    gap: "{spacing.md} * 1.5",
  });
  assert.equal(resolved.gap, "calc(1rem * 1.5)");
});

test("resolveReferences does not wrap values that look like hex colors", () => {
  const resolved = resolveReferences({ color: { primary: "#1a1a1a" } });
  assert.equal(resolved.color.primary, "#1a1a1a");
});

test("resolveReferences throws on unknown references", () => {
  assert.throws(
    () => resolveReferences({ a: "{missing}" }),
    /unknown token reference/
  );
});

test("resolveReferences throws on circular references", () => {
  assert.throws(
    () => resolveReferences({ a: "{b}", b: "{a}" }),
    /circular token reference/
  );
});

test("convert emits calc() for arithmetic references", () => {
  const css = convert(
    { spacing: { md: "1rem", lg: "{spacing.md} * 2" } },
    { format: "css" }
  );
  assert.match(css, /--spacing-lg: calc\(1rem \* 2\);/);
});

test("validateTokens rejects arrays", () => {
  assert.throws(() => validateTokens({ color: ["#000"] }), TokenValidationError);
});

test("validateTokens rejects null leaves", () => {
  assert.throws(
    () => validateTokens({ color: { primary: null } }),
    TokenValidationError
  );
});

test("validateTokens rejects unknown references", () => {
  assert.throws(
    () => validateTokens({ a: "{nope}" }),
    /unknown token reference/
  );
});

test("validateTokens passes valid tokens", () => {
  assert.equal(
    validateTokens({ color: { primary: "#000" }, n: 1, flag: true }),
    true
  );
});
