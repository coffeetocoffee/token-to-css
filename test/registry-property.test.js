import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNameRegistry, registryFromJSON } from "@token-to-css/core";

/**
 * Property tests for the registry's "provably lossless" round-trip claim.
 *
 * The existing round-trip tests use hand-picked trees, so they cover the shapes
 * someone thought of. This generates many trees — including the kebab-collision
 * cases the canonicaliser exists to resolve — and asserts the invariant holds
 * for all of them:
 *
 *   for every leaf path P in the tree:
 *     registry.pathOf(registry.canonicalOf(P)) === P
 *
 * Two properties are checked independently:
 *   1. canonicity  — distinct paths get distinct canonical names
 *   2. round-trip  — canonicalOf then pathOf returns the original path
 * plus a serialisation property: a registry restored from toJSON()/fromJSON()
 * behaves identically to the one built from the tree.
 *
 * Deterministic PRNG (mulberry32) so a failure is reproducible from the seed in
 * the assertion message.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Segment pools chosen so different naming styles COLLIDE once kebab-cased:
// "primary" + "Hover" and "primaryHover" both kebab to "primary-hover".
const SEGMENTS = [
  "primary",
  "primaryHover",
  "primary_hover",
  "surface",
  "surfaceRaised",
  "brand",
  "brandAlt",
  "md",
  "mdLarge",
  "md_large",
  "x2",
  "xY",
];

const VALUES = ["#3b82f6", "#fff", "1rem", "0.5", "true", "#ef4444"];

/** Build a random nested token tree and return it plus every leaf path. */
function randomTree(rnd, maxDepth = 4) {
  const paths = [];
  const root = {};
  const used = new Set();

  function build(node, path, depth) {
    const breadth = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < breadth; i++) {
      const seg = SEGMENTS[Math.floor(rnd() * SEGMENTS.length)];
      const childPath = [...path, seg];
      // A path string is unique per node, but a NODE may be revisited.
      const key = childPath.join("\u0000");
      const goDeeper = depth < maxDepth && rnd() < 0.55;
      if (goDeeper) {
        // Two different segments can contend for the same object slot only if
        // identical; guard so we do not overwrite a subtree with a leaf.
        if (used.has(key)) continue;
        used.add(key);
        node[seg] = {};
        build(node[seg], childPath, depth + 1);
      } else {
        if (used.has(key)) continue;
        used.add(key);
        node[seg] = VALUES[Math.floor(rnd() * VALUES.length)];
        paths.push(childPath);
      }
    }
  }

  build(root, [], 0);
  return { tree: root, paths };
}

function assertLossless(tokens, paths, label) {
  const reg = buildNameRegistry(tokens);

  // 1. round-trip: canonicalOf then pathOf returns the original path.
  const canonicals = new Map();
  for (const path of paths) {
    const canonical = reg.canonicalOf(path);
    assert.ok(
      typeof canonical === "string" && canonical.length > 0,
      `${label}: empty canonical for ${path.join(".")}`
    );
    const back = reg.pathOf(canonical);
    assert.deepEqual(
      back,
      path,
      `${label}: round-trip failed — ${path.join(".")} -> ${canonical} -> ${
        back ? back.join(".") : String(back)
      }`
    );
    canonicals.set(canonical, path);
  }

  // 2. canonicity: distinct paths must not share a canonical name.
  assert.equal(
    canonicals.size,
    paths.length,
    `${label}: ${paths.length} paths produced only ${canonicals.size} distinct canonical names`
  );

  return reg;
}

test("property: registry round-trips losslessly over 300 random trees", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = mulberry32(seed);
    const { tree, paths } = randomTree(rnd);
    if (!paths.length) continue;
    assertLossless(tree, paths, `seed ${seed}`);
  }
});

test("property: canonicity holds even when every segment kebab-collides", () => {
  // A tree engineered so that all leaves would map to the same base name.
  const tokens = {
    a: { b: { c: { d: "#1", e: "#2", f: "#3" } } },
    aB: { cD: { e: "#4", f: "#5" } },
    a_b: { c_d: { e: "#6" } },
  };
  const reg = buildNameRegistry(tokens);
  const paths = [
    ["a", "b", "c", "d"],
    ["a", "b", "c", "e"],
    ["a", "b", "c", "f"],
    ["aB", "cD", "e"],
    ["aB", "cD", "f"],
    ["a_b", "c_d", "e"],
  ];
  assertLossless(tokens, paths, "kebab-collision tree");
});

test("property: a registry restored from JSON behaves identically", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed);
    const { tree, paths } = randomTree(rnd);
    if (!paths.length) continue;
    const reg = buildNameRegistry(tree);
    const restored = registryFromJSON(reg.toJSON());
    for (const path of paths) {
      const canonical = reg.canonicalOf(path);
      assert.equal(
        restored.canonicalOf(path),
        canonical,
        `seed ${seed}: restored canonical differs for ${path.join(".")}`
      );
      assert.deepEqual(
        restored.pathOf(canonical),
        path,
        `seed ${seed}: restored round-trip failed for ${path.join(".")}`
      );
    }
  }
});

test("property: canonical names are unique across the whole tree", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = mulberry32(seed);
    const { tree, paths } = randomTree(rnd);
    if (!paths.length) continue;
    const reg = buildNameRegistry(tree);
    const seen = new Set();
    for (const path of paths) {
      const c = reg.canonicalOf(path);
      assert.ok(!seen.has(c), `seed ${seed}: canonical ${c} used twice`);
      seen.add(c);
    }
  }
});

test("property: pathOf on an unknown canonical returns null, not a throw", () => {
  const reg = buildNameRegistry({ color: { primary: "#fff" } });
  assert.equal(reg.pathOf("definitely-not-a-canonical"), null);
});
