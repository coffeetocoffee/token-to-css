import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenTokens,
  toCSS,
  toSCSS,
  toBarefoot,
  convert,
  buildSourceMap,
  convertToMap,
  normalizeW3C,
  applyMap,
  diffTokens,
  registerFormat,
} from "../src/index.js";
import { parseLocated } from "../src/locate.js";
import { resolveReferences, registerFunction } from "../src/references.js";
import { validateTokens, TokenValidationError } from "../src/schema.js";
import { mergeTokens } from "../src/merge.js";

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

test("resolveReferences collapses arithmetic when reduce is on (default)", () => {
  const resolved = resolveReferences({
    spacing: { md: "1rem" },
    gap: "{spacing.md} * 1.5",
  });
  assert.equal(resolved.gap, "1.5rem");
});

test("resolveReferences keeps calc() when reduce is off", () => {
  const resolved = resolveReferences(
    { spacing: { md: "1rem" }, gap: "{spacing.md} * 1.5" },
    { reduce: false }
  );
  assert.equal(resolved.gap, "calc(1rem * 1.5)");
});

test("resolveReferences falls back to calc() for mismatched units", () => {
  const resolved = resolveReferences({
    a: "1rem",
    b: "1px",
    gap: "{a} + {b}",
  });
  assert.equal(resolved.gap, "calc(1rem + 1px)");
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

test("convert collapses arithmetic references by default", () => {
  const css = convert(
    { spacing: { md: "1rem", lg: "{spacing.md} * 2" } },
    { format: "css" }
  );
  assert.match(css, /--spacing-lg: 2rem;/);
});

test("convert keeps calc() for arithmetic when reduce is off", () => {
  const css = convert(
    { spacing: { md: "1rem", lg: "{spacing.md} * 2" } },
    { format: "css", reduce: false }
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

test("mergeTokens deep-merges imports with main overriding", () => {
  const merged = mergeTokens(
    { color: { primary: "#222" }, spacing: { md: "2rem" } },
    [{ color: { primary: "#111", bg: "#fff" }, spacing: { sm: "0.5rem" } }]
  );
  assert.deepEqual(merged, {
    color: { primary: "#222", bg: "#fff" },
    spacing: { sm: "0.5rem", md: "2rem" },
  });
});

test("parseLocated records the source line of each leaf token", () => {
  const text = '{\n  "color": {\n    "primary": "#3b82f6"\n  }\n}\n';
  const { tree, loc } = parseLocated(text, "tokens.json");
  assert.equal(tree.color.primary, "#3b82f6");
  assert.deepEqual(loc["color-primary"], { file: "tokens.json", line: 3 });
});

test("buildSourceMap emits a v3 source map mapping variables to source lines", () => {
  const flat = { "color-primary": "#3b82f6" };
  const css = toCSS(flat);
  const map = buildSourceMap(
    css,
    { "color-primary": { file: "tokens.json", line: 3 } },
    {
      format: "css",
      outputFile: "out.css",
      sourcesContent: { "tokens.json": "x" },
    }
  );
  assert.equal(map.version, 3);
  assert.deepEqual(map.sources, ["tokens.json"]);
  assert.equal(map.sourcesContent[0], "x");
  // groups: :root { (none), --color-primary (line 2 0-based), } (none)
  const groups = map.mappings.split(";");
  assert.equal(groups[1], "AAEA");
});

test("convertToMap returns css plus a source map", () => {
  const { css, map } = convertToMap(
    { color: { primary: "#3b82f6" } },
    { "color-primary": { file: "tokens.json", line: 3 } },
    {
      format: "css",
      outputFile: "out.css",
      sourcesContent: { "tokens.json": "x" },
    }
  );
  assert.match(css, /--color-primary/);
  assert.equal(map.version, 3);
  assert.equal(map.sources[0], "tokens.json");
  assert.equal(map.mappings.split(";")[1], "AAEA");
});

test("buildSourceMap reverses barefoot var names to token paths", () => {
  const flat = { "color-primary": "#3b82f6" };
  const css = toBarefoot(flat);
  const map = buildSourceMap(
    css,
    { "color-primary": { file: "tokens.json", line: 3 } },
    { format: "barefoot", outputFile: "out.css" }
  );
  assert.equal(map.sources[0], "tokens.json");
  assert.ok(map.mappings.split(";").includes("AAEA"));
});

test("normalizeW3C unwraps $value leaves", () => {
  assert.deepEqual(
    normalizeW3C({ color: { primary: { $value: "#fff", $type: "color" } } }),
    { color: { primary: "#fff" } }
  );
});

test("normalizeW3C leaves plain tokens untouched", () => {
  assert.deepEqual(
    normalizeW3C({ color: { primary: "#fff" } }),
    { color: { primary: "#fff" } }
  );
});

test("convert accepts W3C design tokens", () => {
  const css = convert(
    {
      color: { primary: { $value: "#3b82f6" } },
      spacing: { md: { $value: "{color.primary}" } },
    },
    { format: "css" }
  );
  assert.match(css, /--color-primary: #3b82f6;/);
  assert.match(css, /--spacing-md: #3b82f6;/);
});

test("convert emits mode blocks for the modes key", () => {
  const tokens = {
    color: { primary: "#3b82f6" },
    modes: { dark: { color: { primary: "#1e3a8a" } } },
  };
  const css = convert(tokens, { format: "css" });
  assert.match(css, /:root \{/);
  assert.match(css, /--color-primary: #3b82f6;/);
  assert.match(css, /:root\[data-mode="dark"\] \{/);
  assert.match(css, /--color-primary: #1e3a8a;/);
});

test("convert selects modes via the modes option", () => {
  const tokens = {
    color: { primary: "#3b82f6" },
    modes: {
      dark: { color: { primary: "#111" } },
      contrast: { color: { primary: "#000" } },
    },
  };
  const css = convert(tokens, { format: "css", modes: ["dark"] });
  assert.match(css, /data-mode="dark"/);
  assert.doesNotMatch(css, /data-mode="contrast"/);
});

test("convert emits a CSS Modules :export block", () => {
  const css = convert({ color: { primary: "#3b82f6" } }, { format: "css-modules" });
  assert.match(css, /:export \{/);
  assert.match(css, /colorPrimary: #3b82f6;/);
});

test("convert emits resolved JSON", () => {
  const out = convert(
    { color: { primary: "#3b82f6", lg: "{color.primary}" } },
    { format: "json" }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.color.primary, "#3b82f6");
  assert.equal(parsed.color.lg, "#3b82f6");
});

test("convert JSON includes resolved modes", () => {
  const out = convert(
    {
      color: { primary: "#3b82f6" },
      modes: { dark: { color: { primary: "#111" } } },
    },
    { format: "json" }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.modes.dark.color.primary, "#111");
});

test("convert applies the tailwind preset", () => {
  const css = convert({ color: { primary: "#3b82f6" } }, { preset: "tailwind" });
  assert.match(css, /--color-primary: #3b82f6;/);
});

test("convert applies the open-props preset", () => {
  const css = convert({ color: { primary: "#3b82f6" } }, { preset: "open-props" });
  assert.match(css, /--indigo-6: #3b82f6;/);
});

test("convertToMap source map reverses preset var names", () => {
  const { map } = convertToMap(
    { color: { primary: "#3b82f6" } },
    { "color-primary": { file: "t.json", line: 3 } },
    { format: "tailwind", outputFile: "out.css" }
  );
  assert.ok(map.mappings.split(";").includes("AAEA"));
});

test("applyMap maps flat names to output vars with a fallback", () => {
  assert.deepEqual(
    applyMap({ "color-primary": "#fff", x: "1" }, { "color-primary": "--tw-c" }),
    { "--tw-c": "#fff", "--x": "1" }
  );
});

test("resolveReferences evaluates color functions", () => {
  const r = resolveReferences({
    primary: "#3b82f6",
    ghost: "alpha({primary}, 50%)",
  });
  assert.equal(r.ghost, "rgba(59, 130, 246, 0.5)");
});

test("resolveReferences evaluates mix/lighten/darken", () => {
  assert.equal(resolveReferences({ c: "lighten(#000000, 20%)" }).c, "#333333");
  assert.equal(resolveReferences({ c: "darken(#ffffff, 20%)" }).c, "#cccccc");
  assert.equal(
    resolveReferences({ c: "mix(#ff0000, #0000ff, 50%)" }).c,
    "#800080"
  );
});

test("multi-statement expressions resolve", () => {
  const r = resolveReferences({ a: "1rem", b: "0.5rem", c: "{a} * 2 + {b}" });
  assert.equal(r.c, "2.5rem");
});

test("convert emits a tailwind @theme block", () => {
  const css = convert({ color: { primary: "#3b82f6" } }, { format: "tailwind" });
  assert.match(css, /@theme \{/);
  assert.match(css, /--color-primary: #3b82f6;/);
});

test("convert emits a style-dictionary document", () => {
  const out = convert({ color: { primary: "#3b82f6" } }, { format: "style-dictionary" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.color.primary.value, "#3b82f6");
});

test("convert emits a JSON Schema", () => {
  const out = convert({ color: { primary: "#3b82f6" } }, { format: "schema" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.$schema.includes("json-schema"), true);
  assert.equal(parsed.properties.color.type, "object");
});

test("convert emits a markdown token report", () => {
  const out = convert({ color: { primary: "#3b82f6" } }, { format: "report" });
  assert.match(out, /Token Report/);
  assert.match(out, /color\.primary/);
});

test("convert applies a named brand override", () => {
  const tokens = {
    color: { primary: "#3b82f6" },
    brands: { acme: { color: { primary: "#ff0000" } } },
  };
  const css = convert(tokens, { format: "css", brand: "acme" });
  assert.match(css, /--color-primary: #ff0000;/);
});

test("convert throws in strict mode on unit mismatch", () => {
  assert.throws(
    () => convert({ a: "1rem", b: "1px", c: "{a} + {b}" }, { strict: true }),
    /mismatched units/
  );
});

test("diffTokens reports added/removed/changed", () => {
  const d = diffTokens({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" });
  assert.deepEqual(d.added, { c: "4" });
  assert.deepEqual(d.removed, {});
  assert.deepEqual(d.changed, { b: { from: "2", to: "3" } });
});

test("parser honors parentheses and precedence", () => {
  assert.equal(
    resolveReferences({ a: "(1rem + 2rem) * 2" }).a,
    "6rem"
  );
  assert.equal(resolveReferences({ a: "1rem + 2rem * 3" }).a, "7rem");
});

test("parser passes unknown CSS functions through", () => {
  assert.equal(
    resolveReferences({ c: "var(--brand)" }).c,
    "var(--brand)"
  );
});

test("parser evaluates rgb and hsl color functions", () => {
  assert.equal(resolveReferences({ c: "rgb(59, 130, 246)" }).c, "#3b82f6");
  assert.equal(resolveReferences({ c: "hsl(0, 100%, 50%)" }).c, "#ff0000");
});

test("parser chains nested function calls", () => {
  const r = resolveReferences({
    w: "#ffffff",
    d: "darken({w}, 20%)",
    m: "mix({d}, #000000, 50%)",
  });
  assert.equal(r.d, "#cccccc");
  assert.equal(r.m, "#666666");
});

test("registerFunction adds a custom reference function", () => {
  registerFunction("double", (args) => String(args[0].value * 2));
  assert.equal(resolveReferences({ x: "double(4)" }).x, "8");
});

test("registerFormat registers a custom output format", () => {
  registerFormat("uppercase", (flat) => Object.keys(flat).join(","));
  const out = convert({ color: { primary: "#fff" } }, { format: "uppercase" });
  assert.match(out, /color-primary/);
});
