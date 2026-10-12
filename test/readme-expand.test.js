import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expandTokens } from "../packages/core/src/index.js";

const README = fileURLToPath(new URL("../README.md", import.meta.url));

// Pull every ```json fenced block out of the README that uses $expand, so the
// documentation is executed rather than trusted. Drift fails the test.
function readmeExpandBlocks() {
  const text = readFileSync(README, "utf8");
  const blocks = [];
  const re = /```json\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1].includes("$expand")) blocks.push(m[1]);
  }
  return blocks;
}

test("README contains $expand examples to verify", () => {
  assert.ok(readmeExpandBlocks().length >= 4);
});

test("every README $expand JSON example expands without error", () => {
  for (const block of readmeExpandBlocks()) {
    const input = JSON.parse(block);
    const { generated } = expandTokens(input);
    assert.ok(generated.length > 0, "example generated no tokens:\n" + block);
  }
});

test("README ramp example: 'light' bounds are honoured (not silently ignored)", () => {
  const input = {
    color: {
      brand: {
        $value: "#3b82f6",
        $expand: { ramp: { light: [20, 80], steps: [100, 700] } },
      },
    },
  };
  const withLight = expandTokens(input).tokens.color.brand;
  const withLightness = expandTokens({
    color: {
      brand: {
        $value: "#3b82f6",
        $expand: { ramp: { lightness: [0.2, 0.8], steps: [100, 700] } },
      },
    },
  }).tokens.color.brand;
  assert.deepEqual(withLight, withLightness);
  const defaults = expandTokens({
    color: { brand: { $value: "#3b82f6", $expand: { ramp: { steps: [100, 700] } } } },
  }).tokens.color.brand;
  assert.notDeepEqual(withLight, defaults, "light bounds must change the output");
});

test("ramp lightness: fractions and percentages are equivalent", () => {
  const ramp = (lightness) =>
    expandTokens({
      c: { $value: "#3b82f6", $expand: { ramp: { lightness, steps: [100, 700] } } },
    }).tokens.c;
  assert.deepEqual(ramp([0.2, 0.8]), ramp([20, 80]));
});

test("ramp lightness: mixed fraction and percentage bounds throw instead of guessing", () => {
  for (const lightness of [[0.2, 80], [20, 0.8], [1, 80]]) {
    assert.throws(
      () => expandTokens({ c: { $value: "#3b82f6", $expand: { ramp: { lightness, steps: [100] } } } }),
      /mixes fractions and percentages/,
      JSON.stringify(lightness)
    );
  }
});

test("README fluid example: unitless min is rejected with a clear error", () => {
  assert.throws(
    () =>
      expandTokens({
        font: { size: { $expand: { fluid: { min: 14, max: "24px", steps: ["sm"] } } } },
      }),
    /is not a length with unit/
  );
});

test("README fluid example: clamp output matches the documented formula", () => {
  const { tokens } = expandTokens({
    font: {
      size: {
        $expand: {
          fluid: { min: "14px", max: "24px", steps: ["sm", "md", "lg"], vwMin: 320, vwMax: 1200 },
        },
      },
    },
  });
  // Steps interpolate from min (first step) to max (last step). Every step
  // shares the same slope; only the bounds change. "sm" is pinned at min and
  // "lg" spans the full 14px..24px range.
  assert.equal(tokens.font.size.sm, "clamp(14px, 10.3636px + 1.1364vw, 14px)");
  assert.equal(tokens.font.size.lg, "clamp(14px, 10.3636px + 1.1364vw, 24px)");
});

test("expandTokens returns generated entries with { path, kind }", () => {
  const { generated } = expandTokens({
    spacing: { $expand: { scale: { base: 4, ratio: 1.5, steps: ["xs"], unit: "px" } } },
  });
  assert.deepEqual(generated, [{ path: "spacing.xs", kind: "scale" }]);
});
