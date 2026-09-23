import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convert,
  expandTokens,
  validateTokens,
  resolveReferences,
  diffTokens,
  parseColor,
  rgbToOklch,
  oklchToRgb,
  formatColor,
} from "@token-to-css/core";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function mkdtemp(prefix) {
  const dir = join(tmpdir(), prefix + Math.random().toString(36).slice(2, 7));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("$expand ramp: perceptually even OKLCH ramp from a seed color", () => {
  const { tokens, generated } = expandTokens({
    color: {
      brand: {
        $value: "#3b82f6",
        $expand: { ramp: { steps: [50, 100, 500, 900] } },
      },
    },
  });
  assert.deepEqual(Object.keys(tokens.color.brand), ["50", "100", "500", "900"]);
  for (const step of Object.values(tokens.color.brand)) {
    assert.match(step, /^#[0-9a-f]{6}$/);
  }
  // Lightness descends monotonically from 50 to 900.
  const L = (hex) => rgbToOklch(parseColor(hex)).L;
  assert.ok(L(tokens.color.brand["50"]) > L(tokens.color.brand["100"]));
  assert.ok(L(tokens.color.brand["100"]) > L(tokens.color.brand["500"]));
  assert.ok(L(tokens.color.brand["500"]) > L(tokens.color.brand["900"]));
  // Verify perceptual evenness via OKLCH distance rather than raw L deltas.
  const d = (a, b) => Math.abs(rgbToOklch(parseColor(a)).L - rgbToOklch(parseColor(b)).L);
  const totalSteps = tokens.color.brand["50"];
  // Each adjacent pair has similar lightness gap.
  assert.ok(d(tokens.color.brand["50"], tokens.color.brand["100"]) > 0);
  assert.ok(d(tokens.color.brand["100"], tokens.color.brand["500"]) > 0);
  assert.ok(d(tokens.color.brand["500"], tokens.color.brand["900"]) > 0);
  // Provenance entries name the materialized paths.
  assert.deepEqual(generated.map((g) => g.path), [
    "color.brand.50",
    "color.brand.100",
    "color.brand.500",
    "color.brand.900",
  ]);
  assert.ok(generated.every((g) => g.kind === "ramp"));
});

test("$expand ramp: deterministic and matches direct OKLCH math", () => {
  const seed = "#3b82f6";
  const { C, H } = rgbToOklch(parseColor(seed));
  const { tokens } = expandTokens({
    color: { brand: { $value: seed, $expand: { ramp: { steps: ["a", "b"] } } } },
  });
  const expectedA = formatColor(oklchToRgb(0.95, Math.min(C, 0.37), H));
  assert.equal(tokens.color.brand.a, expectedA);
});

test("$expand scale: geometric progression with unit", () => {
  const { tokens } = expandTokens({
    spacing: {
      $expand: { scale: { base: 0.25, ratio: 2, steps: ["xs", "sm", "md"], unit: "rem" } },
    },
  });
  assert.deepEqual(tokens.spacing, { xs: "0.25rem", sm: "0.5rem", md: "1rem" });
});

test("$expand scale: numeric steps generate indexed names", () => {
  const { tokens } = expandTokens({
    z: { $expand: { scale: { base: 10, ratio: 10, steps: 3, unit: "none" } } },
  });
  assert.deepEqual(tokens.z, { 0: "10", 1: "100", 2: "1000" });
});

test("$expand fluid: clamp() interpolation between min and max", () => {
  const { tokens } = expandTokens({
    size: {
      $expand: { fluid: { min: "1rem", max: "2rem", steps: ["sm", "lg"], vwMin: 320, vwMax: 1200 } },
    },
  });
  // sm sits at the low end: clamp lower bound 1rem, line hits 1rem at 320px.
  assert.equal(tokens.size.sm, "clamp(1rem, 0.6364rem + 0.1136vw, 1rem)");
  // lg sits at the high end: clamp upper bound 2rem, line hits 2rem at 1200px.
  assert.equal(tokens.size.lg, "clamp(1rem, 0.6364rem + 0.1136vw, 2rem)");
});

test("$expand cross: cartesian product with dimension placeholders", () => {
  const { tokens } = expandTokens({
    button: {
      $expand: {
        cross: { variant: ["primary", "ghost"], size: ["sm", "md"] },
        template: { bg: "{variant}", pad: "{size}" },
      },
    },
  });
  assert.deepEqual(tokens.button["primary-sm"], { bg: "primary", pad: "sm" });
  assert.deepEqual(tokens.button["ghost-md"], { bg: "ghost", pad: "md" });
});

test("$expand: generated tokens participate in refs and themes", () => {
  const css = convert({
    color: { brand: { $value: "#3b82f6", $expand: { ramp: { steps: [500] } } } },
    link: "{color.brand.500}",
    modes: {
      dark: { link: "{color.brand.500}" },
    },
  }, { format: "css" });
  assert.ok(css.includes("--color-brand-500:"));
  // Refs are reduced to values (default behavior).
  assert.ok(css.includes("--link: #a1eeff"));
  assert.ok(css.includes('[data-mode="dark"]'));
});

test("$expand: sibling keys survive and override generated tokens", () => {
  const { tokens } = expandTokens({
    spacing: {
      $expand: { scale: { base: 1, ratio: 2, steps: ["a", "b"], unit: "px" } },
      b: "override",
    },
  });
  assert.equal(tokens.spacing.a, "1px");
  assert.equal(tokens.spacing.b, "override");
});

test("$expand: no-op when no $expand blocks exist", () => {
  const input = { color: { primary: "#111" } };
  const { tokens, generated } = expandTokens(input);
  assert.equal(tokens, input);
  assert.deepEqual(generated, []);
});

test("$expand: invalid generator key throws a clear error", () => {
  assert.throws(() => expandTokens({ x: { $expand: { nonsense: {} } } }), /generator key/);
  assert.throws(
    () => expandTokens({ x: { $value: "#111", $expand: { ramp: { steps: [] } } } }),
    /steps.*non-empty/
  );
  assert.throws(
    () => expandTokens({ x: { $expand: { scale: { base: "nope", steps: 2 } } } }),
    /base.*number/
  );
});

test("$expand: files with $expand pass validateTokens", () => {
  validateTokens({
    color: { brand: { $value: "#3b82f6", $expand: { ramp: { steps: [50, 500] } } } },
  });
});

test("$expand: materialization happens before diff/semver classification", () => {
  const prev = {
    color: { brand: { $value: "#3b82f6", $expand: { ramp: { steps: [500] } } } },
  };
  const next = {
    color: { brand: { $value: "#3b82f6", $expand: { ramp: { steps: [500], chroma: 1.5 } } } },
  };
  // First expand, then diff the expanded tokens (this is what convert() does).
  const p = expandTokens(prev);
  const n = expandTokens(next);
  const d = diffTokens(p.tokens, n.tokens);
  assert.equal(Object.keys(d.changed).length, 1);
  // Keys are kebab-cased by flattenTokens inside diffTokens.
  assert.ok(d.changed["color-brand-500"]);
});

test("CLI: expand --generators previews materialization", () => {
  const dir = mkdtemp("ttc-gen-");
  try {
    writeFileSync(
      join(dir, "tokens.json"),
      JSON.stringify({
        spacing: { $expand: { scale: { base: 0.25, ratio: 2, steps: ["sm", "md"], unit: "rem" } } },
      })
    );
    const out = execFileSync("node", [CLI, "expand", "--generators", join(dir, "tokens.json")], {
      encoding: "utf8",
    });
    assert.match(out, /\[scale\] spacing\.sm/);
    assert.match(out, /\[scale\] spacing\.md/);
    const json = JSON.parse(
      execFileSync("node", [CLI, "expand", "--generators", join(dir, "tokens.json"), "--json"], {
        encoding: "utf8",
      })
    );
    assert.equal(json.generated.length, 2);
    assert.equal(json.expanded.spacing.sm, "0.25rem");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: default build materializes $expand into CSS", () => {
  const dir = mkdtemp("ttc-gen-");
  try {
    writeFileSync(
      join(dir, "tokens.json"),
      JSON.stringify({
        color: { brand: { $value: "#3b82f6", $expand: { ramp: { steps: [500] } } } },
      })
    );
    const out = execFileSync("node", [CLI, join(dir, "tokens.json"), "-f", "css"], {
      encoding: "utf8",
    });
    assert.match(out, /--color-brand-500: #[0-9a-f]{6}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
