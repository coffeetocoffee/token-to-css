import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildKit,
  buildComponentsCSS,
  getComponentContract,
  convert,
  reverse,
  reverseTailwind,
  registerFlutterConnector,
  tokensToFlutterTheme,
  flutterThemeToTokens,
  buildFlutterDart,
  registerComposeConnector,
  tokensToComposeTheme,
  composeThemeToTokens,
  buildComposeKotlin,
  getConnector,
  listConnectors,
  connectorPush,
  connectorPull,
} from "../src/index.js";
import { lintConsumer } from "../src/adopt.js";

// --- v14: kit --components — themeable primitives --------------------------------

const tokens = {
  color: {
    primary: "#3b82f6",
    primaryHover: "#2563eb",
    background: "#ffffff",
    surface: "#f4f4f5",
    text: "#111827",
    muted: "#6b7280",
    border: "#e5e7eb",
  },
  radius: { sm: "4px", md: "6px", lg: "12px" },
  font: { family: "Inter, system-ui" },
  control: { height: "3rem" },
};

test("v14: kit --components emits themeable button/input/card/focus primitives", () => {
  const kit = buildKit(tokens, { components: true });
  assert.match(kit.components, /\.ttc-button/);
  assert.match(kit.components, /\.ttc-input/);
  assert.match(kit.components, /\.ttc-card/);
  assert.match(kit.components, /focus-visible/);
  // Themeable values are var() references, never inlined literals.
  assert.match(kit.components, /var\(--color-primary\)/);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(kit.components),
    "components carry no inlined color literals"
  );
});

test("v14: kit --components is opt-in", () => {
  assert.equal(buildKit(tokens).components, "");
  assert.ok(buildComponentsCSS(tokens).includes(".ttc-button"));
});

test("v14: a token edit restyles the generated button end-to-end", () => {
  const before = buildKit(tokens, { components: true });
  const edited = {
    ...tokens,
    color: { ...tokens.color, primary: "#ef4444" },
  };
  const after = buildKit(edited, { components: true });
  // The kit variable flips…
  assert.match(before.css, /--color-primary: #3b82f6/);
  assert.match(after.css, /--color-primary: #ef4444/);
  // …and the button reads that same live variable, so it restyles with no
  // component-layer change.
  assert.match(after.components, /var\(--color-primary\)/);
  const contract = getComponentContract();
  assert.ok(contract.optional.includes("color.primary"));
});

test("v14: components.css is lintable by the v9 consumer lint", () => {
  const { components } = buildKit(tokens, { components: true });
  const report = lintConsumer(tokens, [{ file: "components.css", text: components }]);
  assert.ok(Array.isArray(report.findings));
  assert.equal(
    report.findings.filter((f) => f.kind === "color").length,
    0,
    "no hardcoded colors — primitives use var()"
  );
  assert.equal(report.findings.length, 0);
});

// --- v14: Tailwind v4 CSS-first round-trip ----------------------------------------

const twTokens = {
  color: { primary: "#3b82f6", text: "#111827", background: "#ffffff" },
  radius: { md: "0.375rem" },
};

test("v14: reverse(tailwindTheme) round-trips token values", () => {
  const css = convert(twTokens, { format: "tailwind" });
  assert.match(css, /@theme/);
  assert.match(css, /--color-foreground: #111827/);
  const back = reverse(css);
  assert.deepEqual(back, twTokens);
});

test("v14: reverseTailwind folds @theme back into tokens (incl. @theme inline)", () => {
  const css = convert(twTokens, { format: "tailwind" });
  assert.deepEqual(reverseTailwind(css), twTokens);
  assert.deepEqual(reverse(css.replace("@theme", "@theme inline")), twTokens);
});

// --- v14: Flutter / Compose connectors via the v8 SDK -----------------------------

test("v14: flutter connector round-trips through registerConnector", async () => {
  registerFlutterConnector({});
  assert.ok(listConnectors().includes("flutter"));
  assert.equal(typeof getConnector("flutter").push, "function");

  const doc = tokensToFlutterTheme(tokens);
  assert.equal(doc.theme.primary, "#3b82f6");
  assert.deepEqual(flutterThemeToTokens(doc), tokens);

  const dart = buildFlutterDart(tokens);
  assert.match(dart, /TokenColors/);
  assert.match(dart, /Color\(0xFF3B82F6\)/);
  // The `flutter` output format arrives via the connector SDK — zero core changes.
  assert.match(convert(tokens, { format: "flutter" }), /TokenColors/);
  // Non-scalar theme values degrade to comments, never "[object Object]".
  const nested = buildFlutterDart({ font: { family: { sans: "system-ui" } } });
  assert.ok(!nested.includes("[object Object]"));
});

test("v14: flutter push/pull round-trips through the connector hub", async () => {
  let stored = null;
  const stub = async (_url, init = {}) => {
    if (init.method === "PUT") {
      stored = JSON.parse(init.body);
      return { ok: true, json: async () => ({ saved: true }) };
    }
    return { ok: true, json: async () => stored };
  };
  registerFlutterConnector({ fetchImpl: stub, url: "https://example.invalid/theme" });
  const res = await connectorPush("flutter", tokens);
  assert.deepEqual(res, { saved: true });
  assert.deepEqual(await connectorPull("flutter"), tokens);
});

test("v14: compose connector round-trips through registerConnector", () => {
  registerComposeConnector({});
  assert.ok(listConnectors().includes("compose"));

  const doc = tokensToComposeTheme(tokens);
  assert.equal(doc.theme.primary, "#3b82f6");
  assert.deepEqual(composeThemeToTokens(doc), tokens);

  const kotlin = buildComposeKotlin(tokens);
  assert.match(kotlin, /object TokenColors/);
  assert.match(kotlin, /Color\(0xFF3B82F6\)/);
  assert.match(convert(tokens, { format: "compose" }), /TokenColors/);
  const nested = buildComposeKotlin({ font: { family: { sans: "system-ui" } } });
  assert.ok(!nested.includes("[object Object]"));
});
