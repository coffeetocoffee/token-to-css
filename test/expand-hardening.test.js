import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTokens } from "@token-to-css/core";

const fluid = (spec) =>
  expandTokens({ t: { $expand: { fluid: spec } } }).tokens.t;
const ramp = (spec, seed) =>
  expandTokens({ color: { brand: { $value: seed ?? "#3b82f6", $expand: { ramp: spec } } } })
    .tokens.color.brand;
const cross = (spec) =>
  expandTokens({ b: { $expand: spec } }).tokens.b;

// ---------------------------------------------------------------------------
// Unbounded cross product — a cap with an actionable error
// ---------------------------------------------------------------------------

test("a small cross product still expands normally", () => {
  const out = cross({
    cross: { variant: ["primary", "ghost"], size: ["sm", "md"] },
    template: { bg: "{color.{variant}}" },
  });
  assert.equal(Object.keys(out).length, 4);
  assert.ok("primary-sm" in out);
  assert.ok("ghost-md" in out);
});

test("a cross product exactly at the cap is allowed", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
  const out = cross({ cross: { a: mk(64), b: mk(64) }, template: { x: "{a}" } });
  assert.equal(Object.keys(out).length, 4096);
});

test("a cross product over the cap throws with the combination count", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
  assert.throws(
    () => cross({ cross: { a: mk(20), b: mk(20), c: mk(20) }, template: { x: "1" } }),
    /8000 combinations \(a\[20\] x b\[20\] x c\[20\]\) exceeds the limit of 4096/
  );
});

test("the error names the offending group and suggests a fix", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
  assert.throws(
    () =>
      expandTokens({
        button: { $expand: { cross: { a: mk(100), b: mk(100) }, template: { x: "1" } } },
      }),
    /at "button".*split it into smaller \$expand groups/
  );
});

// ---------------------------------------------------------------------------
// fluid: a descending range must emit valid CSS
//
// clamp(MIN, VAL, MAX) requires MIN <= MAX. With max < min the old code
// emitted clamp(2rem, ..., 1rem), which is invalid and collapses to a
// constant.
// ---------------------------------------------------------------------------

test("ascending fluid is unchanged (regression guard)", () => {
  const out = fluid({ min: "1rem", max: "2rem", steps: ["sm", "md", "lg"], vwMin: 320, vwMax: 1200 });
  assert.equal(out.sm, "clamp(1rem, 0.6364rem + 0.1136vw, 1rem)");
  assert.equal(out.md, "clamp(1rem, 0.6364rem + 0.1136vw, 1.5rem)");
  assert.equal(out.lg, "clamp(1rem, 0.6364rem + 0.1136vw, 2rem)");
});

test("descending fluid orders its clamp bounds (MIN <= MAX)", () => {
  const out = fluid({ min: "2rem", max: "1rem", steps: ["sm", "md", "lg"], vwMin: 320, vwMax: 1200 });
  assert.equal(out.sm, "clamp(2rem, 2.3636rem + -0.1136vw, 2rem)");
  assert.equal(out.md, "clamp(1.5rem, 2.3636rem + -0.1136vw, 2rem)");
  assert.equal(out.lg, "clamp(1rem, 2.3636rem + -0.1136vw, 2rem)");
});

test("every emitted fluid clamp has a lower bound <= its upper bound", () => {
  const num = (s) => parseFloat(s);
  for (const spec of [
    { min: "1rem", max: "2rem", steps: ["a", "b", "c", "d"], vwMin: 320, vwMax: 1200 },
    { min: "2rem", max: "1rem", steps: ["a", "b", "c", "d"], vwMin: 320, vwMax: 1200 },
    { min: "16px", max: "4px", steps: ["a", "b"], vwMin: 400, vwMax: 1600 },
    { min: "3rem", max: "3rem", steps: ["a", "b"], vwMin: 320, vwMax: 1200 },
  ]) {
    const out = fluid(spec);
    for (const [name, value] of Object.entries(out)) {
      const m = /^clamp\((-?[\d.]+)(px|rem|em|ch|ex|%), .*, (-?[\d.]+)\2\)$/.exec(value);
      assert.ok(m, `${name}: unparseable clamp — ${value}`);
      assert.ok(
        num(m[1]) <= num(m[3]),
        `${name}: lower bound ${m[1]} exceeds upper bound ${m[3]} — ${value}`
      );
    }
  }
});

test("descending fluid still interpolates across steps", () => {
  const out = fluid({ min: "2rem", max: "1rem", steps: ["a", "b", "c"], vwMin: 320, vwMax: 1200 });
  // Lower bounds should descend as the steps approach max.
  const lower = (s) => parseFloat(/^clamp\((-?[\d.]+)rem/.exec(s)[1]);
  assert.ok(lower(out.a) > lower(out.b));
  assert.ok(lower(out.b) > lower(out.c));
});

// ---------------------------------------------------------------------------
// numeric `steps` produced meaningless names ("0".."n-1")
// ---------------------------------------------------------------------------

test("ramp with a numeric step count yields palette-style names", () => {
  const out = ramp({ steps: 5 });
  assert.deepEqual(Object.keys(out), ["50", "200", "400", "600", "900"]);
});

test("ramp numeric counts across the conventional range", () => {
  assert.deepEqual(Object.keys(ramp({ steps: 1 })), ["500"]);
  assert.deepEqual(Object.keys(ramp({ steps: 3 })), ["100", "500", "900"]);
  assert.deepEqual(Object.keys(ramp({ steps: 7 })), [
    "50", "100", "200", "300", "500", "700", "900",
  ]);
});

test("ramp never emits a bare '0' name for a count", () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    const names = Object.keys(ramp({ steps: n }));
    assert.equal(names.length, n);
    assert.ok(!names.includes("0"), `steps:${n} produced a '0' name: ${names}`);
    assert.ok(names.every((s) => /^\d+$/.test(s)), `steps:${n}: non-numeric name in ${names}`);
  }
});

test("ramp beyond the naming table still interpolates into 50..950", () => {
  const names = Object.keys(ramp({ steps: 20 })).map(Number);
  assert.equal(names.length, 20);
  assert.equal(names[0], 50);
  assert.equal(names[19], 950);
  // Strictly increasing.
  for (let i = 1; i < names.length; i++) assert.ok(names[i] > names[i - 1]);
});

test("explicit ramp step names are still honoured verbatim", () => {
  assert.deepEqual(Object.keys(ramp({ steps: [100, 500, 900] })), ["100", "500", "900"]);
  assert.deepEqual(Object.keys(ramp({ steps: ["light", "dark"] })), ["light", "dark"]);
});

test("scale/fluid keep index names, since a count carries no scale meaning", () => {
  const s = expandTokens({ spacing: { $expand: { scale: { base: 4, ratio: 1.5, steps: 3 } } } })
    .tokens.spacing;
  assert.deepEqual(Object.keys(s), ["0", "1", "2"]);
});
