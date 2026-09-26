import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deepMerge,
  mergeTokens,
  createChangeRequest,
  approveChangeRequest,
  applyChangeRequest,
  resolveReferences,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Prototype pollution — deepMerge / mergeTokens / applyChangeRequest
//
// A token tree is attacker-controlled on several reachable paths (connector
// pull(), POST /tokens, and an approved change-request's `proposed` payload).
// None of them may reach Object.prototype.
// ---------------------------------------------------------------------------

test("deepMerge ignores __proto__ and does not pollute Object.prototype", () => {
  const malicious = JSON.parse('{"__proto__": {"polluted": true}}');
  const out = deepMerge({}, malicious);

  assert.equal({}.polluted, undefined, "Object.prototype must not be polluted");
  assert.equal(out.polluted, undefined, "the key must not be copied");
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test("deepMerge ignores constructor.prototype", () => {
  const malicious = JSON.parse('{"constructor": {"prototype": {"polluted": true}}}');
  deepMerge({}, malicious);

  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("deepMerge drops a nested __proto__ key entirely", () => {
  const malicious = JSON.parse('{"color": {"__proto__": {"polluted": true}}}');
  const out = deepMerge({}, malicious);

  assert.equal({}.polluted, undefined, "Object.prototype must not be polluted");
  // The key must not survive even as an inert own property — leaving it in
  // place would still corrupt the emitted token tree.
  assert.deepEqual(Object.getOwnPropertyNames(out.color), []);
  assert.deepEqual(out, { color: {} });
});

test("governance-style merge: __proto__ cannot pollute via target[key] = {}", () => {
  // This is the genuinely exploitable shape. `target["__proto__"] = {}`
  // does NOT create a property — it mutates the target's prototype, so the
  // subsequent recursive write lands on Object.prototype itself.
  // applyChangeRequest uses exactly this merge, fed by an attacker-supplied CR.
  const source = { color: { primary: "#3b82f6" } };
  const cr = {
    id: "cr-proto",
    status: "approved",
    proposed: JSON.parse('{"__proto__": {"polluted": true}}'),
  };

  applyChangeRequest(source, cr);
  assert.equal({}.polluted, undefined, "Object.prototype must survive an approved CR");
  assert.equal(Object.prototype.polluted, undefined);
});

test("constructor.prototype is blocked too", () => {
  const source = { color: { primary: "#3b82f6" } };
  const cr = {
    id: "cr-ctor",
    status: "approved",
    proposed: JSON.parse('{"constructor": {"prototype": {"polluted": true}}}'),
  };

  applyChangeRequest(source, cr);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("deepMerge still merges legitimate keys normally", () => {
  const out = deepMerge({ a: { x: 1 } }, { a: { y: 2 }, b: 3 });
  assert.deepEqual(out, { a: { x: 1, y: 2 }, b: 3 });
});

test("mergeTokens rejects a polluted import document", () => {
  const malicious = JSON.parse('{"__proto__": {"polluted": true}}');
  const merged = mergeTokens({ color: { primary: "#222" } }, [malicious]);

  assert.equal({}.polluted, undefined);
  assert.deepEqual(merged, { color: { primary: "#222" } });
});

test("applyChangeRequest rejects a polluted CR payload", () => {
  const source = { color: { primary: "#3b82f6" } };
  const cr = {
    id: "cr-pollution",
    status: "approved",
    proposed: JSON.parse('{"__proto__": {"polluted": true}, "color": {"bg": "#fff"}}'),
  };

  const { tree } = applyChangeRequest(source, cr);

  assert.equal({}.polluted, undefined, "an approved CR must not pollute the process");
  assert.deepEqual(tree, { color: { primary: "#3b82f6", bg: "#fff" } });
});

test("an end-to-end CR cannot pollute even when built via the public API", () => {
  const source = { color: { primary: "#3b82f6" } };
  const created = createChangeRequest(source, {
    proposed: JSON.parse('{"__proto__": {"polluted": true}}'),
    author: "attacker",
  });
  const approved = approveChangeRequest(created, { approver: "someone" });
  applyChangeRequest(source, approved);

  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

// ---------------------------------------------------------------------------
// rgb() / hsl() arity
//
// Wrong arity used to format an invalid color silently (rgb(1,2) produced
// {r:1,g:2,b:undefined}). It must throw instead.
// ---------------------------------------------------------------------------

const resolve = (value) => resolveReferences({ probe: value }).probe;

test("rgb() rejects too few arguments", () => {
  assert.throws(() => resolve("rgb(1, 2)"), /rgb\(\) expects 3 arguments, got 2/);
});

test("rgb() rejects too many arguments", () => {
  assert.throws(() => resolve("rgb(1, 2, 3, 4)"), /rgb\(\) expects 3 arguments, got 4/);
});

test("rgb() still accepts exactly three", () => {
  assert.equal(resolve("rgb(255, 0, 0)"), "#ff0000");
});

test("hsl() rejects too few arguments", () => {
  assert.throws(() => resolve("hsl(200)"), /hsl\(\) expects 3 arguments, got 1/);
});

test("hsl() rejects too many arguments", () => {
  assert.throws(() => resolve("hsl(200, 50, 50, 1)"), /hsl\(\) expects 3 arguments, got 4/);
});

test("hsl() still accepts exactly three", () => {
  assert.equal(resolve("hsl(0, 100, 50)"), "#ff0000");
});

// ---------------------------------------------------------------------------
// asRatio — the % unit travels with the value
//
// Previously asNumber returned a bare number while each caller re-read
// `.unit` off the original token. Behaviour must be unchanged: 50% and 0.5
// are the same ratio.
// ---------------------------------------------------------------------------

test("alpha() treats 50% and 0.5 identically", () => {
  const pct = resolve("alpha(#ff0000, 50%)");
  const raw = resolve("alpha(#ff0000, 0.5)");
  assert.equal(pct, raw);
});

test("lighten() and darken() interpret percentages as ratios", () => {
  assert.equal(resolve("lighten(#000000, 50%)"), resolve("lighten(#000000, 0.5)"));
  assert.equal(resolve("darken(#ffffff, 50%)"), resolve("darken(#ffffff, 0.5)"));
});

test("mix() defaults to 0.5 when the weight is omitted, and honours a %", () => {
  assert.equal(resolve("mix(#000000, #ffffff)"), resolve("mix(#000000, #ffffff, 50%)"));
  assert.equal(resolve("mix(#000000, #ffffff, 50%)"), resolve("mix(#000000, #ffffff, 0.5)"));
});
