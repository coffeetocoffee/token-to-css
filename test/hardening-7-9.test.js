import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTokens, TokenValidationError } from "@token-to-css/core";
import {
  timingSafeTokenLookup,
  createNamespacedAuth,
  createOrgAuth,
} from "@token-to-css/core";
import { createTokenServer } from "../src/serve.js";

// ---------------------------------------------------------------------------
// A malformed $expand is a TokenValidationError, not a raw Error
//
// expandTokens runs before validateTokens, so a bad $expand used to surface as
// a plain Error and callers could not tell an authoring mistake from a bug.
// ---------------------------------------------------------------------------

const BAD_EXPAND = [
  ["ramp with an unparseable seed", { c: { x: { $value: "notacolor", $expand: { ramp: { steps: [1] } } } } }],
  ["scale with a non-numeric base", { s: { $expand: { scale: { base: "x", steps: ["a"] } } } }],
  ["fluid with an unparseable length", { f: { $expand: { fluid: { min: "abc", max: "1rem", steps: ["a"] } } } }],
  ["fluid with mismatched units", { f: { $expand: { fluid: { min: "1rem", max: "2px", steps: ["a"] } } } }],
  ["fluid with vwMax <= vwMin", { f: { $expand: { fluid: { min: "1rem", max: "2rem", steps: ["a"], vwMin: 900, vwMax: 300 } } } }],
  ["ramp with empty steps", { c: { x: { $value: "#fff", $expand: { ramp: { steps: [] } } } } }],
  ["cross with an empty dimension", { b: { $expand: { cross: { a: [] }, template: {} } } }],
  ["cross with a non-array dimension", { b: { $expand: { cross: { a: 1 }, template: {} } } }],
  ["cross with a non-object template", { b: { $expand: { cross: { a: ["x"] }, template: 5 } } }],
  ["cross over the combination cap", { b: { $expand: { cross: { a: Array(100).fill(1), b: Array(100).fill(1) }, template: {} } } }],
  ["$expand that is not an object", { g: { $expand: 42 } }],
  ["$expand with no known generator", { g: { $expand: { bogus: {} } } }],
];

for (const [label, tree] of BAD_EXPAND) {
  test(`${label} throws TokenValidationError`, () => {
    assert.throws(
      () => expandTokens(tree),
      (err) => {
        assert.ok(
          err instanceof TokenValidationError,
          `expected TokenValidationError, got ${err.name}: ${err.message}`
        );
        assert.equal(err.name, "TokenValidationError");
        // Still carries the actionable $expand detail.
        assert.match(err.message, /\$expand/);
        return true;
      }
    );
  });
}

test("a valid $expand still succeeds and generates tokens", () => {
  const { tokens, generated } = expandTokens({
    color: { brand: { $value: "#3b82f6", $expand: { ramp: { steps: [50, 900] } } } },
  });
  assert.deepEqual(Object.keys(tokens.color.brand), ["50", "900"]);
  assert.equal(generated.length, 2);
});

test("TokenValidationError is exported and instanceof Error", () => {
  const err = new TokenValidationError("x");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof TokenValidationError);
});

// ---------------------------------------------------------------------------
// timing-safe token lookup
//
// A plain `auth[token]` short-circuits on the first differing byte. The
// replacement must accept exactly the right token and nothing else, with work
// independent of match position and length.
// ---------------------------------------------------------------------------

const MAP = {
  "admin-token": { scope: "write", teams: ["*"] },
  "viewer-token": { scope: "read", teams: ["*"] },
};

test("lookup returns the entry for an exact match", () => {
  assert.deepEqual(timingSafeTokenLookup(MAP, "admin-token"), { scope: "write", teams: ["*"] });
  assert.deepEqual(timingSafeTokenLookup(MAP, "viewer-token"), { scope: "read", teams: ["*"] });
});

test("lookup rejects near-misses that share a prefix", () => {
  for (const candidate of [
    "admin-toke",
    "admin-tokeX",
    "admin-token-extra",
    "admin",
    "dmin-token",
    "Admin-token",
    " admin-token",
    "admin-token ",
  ]) {
    assert.equal(
      timingSafeTokenLookup(MAP, candidate),
      null,
      `must not match ${JSON.stringify(candidate)}`
    );
  }
});

test("lookup rejects non-strings, empty, and prototype keys", () => {
  for (const candidate of [null, undefined, "", 0, 123, {}, [], true]) {
    assert.equal(timingSafeTokenLookup(MAP, candidate), null);
  }
  // `__proto__` / `constructor` must not resolve through the prototype chain.
  assert.equal(timingSafeTokenLookup(MAP, "__proto__"), null);
  assert.equal(timingSafeTokenLookup(MAP, "constructor"), null);
  assert.equal(timingSafeTokenLookup(MAP, "prototype"), null);
});

test("lookup handles an empty token map", () => {
  assert.equal(timingSafeTokenLookup({}, "anything"), null);
});

test("lookup does not leak match position via a length-dependent early exit", () => {
  // Both candidates are the same length and differ only in the last byte, so a
  // naive implementation would compare the whole string in each case. This
  // asserts the observable result is identical (the timing property itself is
  // not measurable in a unit test; the code path is what is being pinned).
  assert.equal(timingSafeTokenLookup({ aaaaaaaaaa: 1 }, "aaaaaaaaaa"), 1);
  assert.equal(timingSafeTokenLookup({ aaaaaaaaaa: 1 }, "aaaaaaaaab"), null);
  assert.equal(timingSafeTokenLookup({ aaaaaaaaaa: 1 }, "baaaaaaaaa"), null);
});

test("createNamespacedAuth resolves through the safe lookup", () => {
  const resolve = createNamespacedAuth({ tokens: MAP });
  assert.equal(resolve("admin-token"), "write");
  assert.equal(resolve("viewer-token"), "read");
  assert.equal(resolve("admin-tokeX"), null);
  assert.equal(resolve(""), null);
  // Team scoping still applies.
  assert.equal(resolve("admin-token", "core"), "write");
});

test("team scoping is still enforced after the lookup change", () => {
  const resolve = createNamespacedAuth({
    tokens: { "core-tok": { scope: "write", teams: ["core"] } },
  });
  assert.equal(resolve("core-tok", "core"), "write");
  assert.equal(resolve("core-tok", "web"), null);
  assert.equal(resolve("core-tok"), "write");
});

test("createOrgAuth resolves through the safe lookup and keeps org trust", () => {
  const resolve = createOrgAuth({
    tokens: { "acme-tok": { scope: "write", org: "acme", teams: ["*"] } },
  });
  assert.equal(resolve("acme-tok", "acme"), "write");
  assert.equal(resolve("acme-tok", "other"), null, "a foreign org must not resolve");
  assert.equal(resolve("acme-tokX", "acme"), null, "a near-miss must not resolve");
  assert.equal(resolve.orgAware, true, "the orgAware marker must survive");
});

// ---------------------------------------------------------------------------
// cors: true must not advertise the write surface to every origin
// ---------------------------------------------------------------------------

async function withServer(options, fn) {
  const server = createTokenServer({ watch: false, ...options });
  await new Promise((r) => server.listen(0, r));
  const base = "http://localhost:" + server.address().port;
  try {
    return await fn(base, server);
  } finally {
    if (server.closeAll) server.closeAll();
    server.close();
  }
}

const preflight = (base) =>
  fetch(base + "/tokens", {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
  });

test("cors: true still advertises the write surface (the playground depends on it)", async () => {
  await withServer({ tokens: { a: 1 }, cors: true }, async (base) => {
    const res = await preflight(base);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    // Regression guard: this IS the hosted playground's write path. Narrowing
    // it would break a shipped, documented flow, so it must stay wide.
    assert.match(res.headers.get("access-control-allow-methods"), /POST/);
    assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
  });
});

test("cors: true with auth warns that the tree is readable by any origin", async () => {
  const warnings = [];
  const orig = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    createTokenServer({
      tokens: { secret: { value: "x" } },
      auth: { t: "read" },
      cors: true,
      watch: false,
    }).close();
  } finally {
    console.error = orig;
  }
  assert.ok(
    warnings.some((w) => /any origin to READ/.test(w)),
    `expected a wildcard-exposure warning, got: ${JSON.stringify(warnings)}`
  );
});

test("cors: true without auth does not warn (the open playground is the point)", async () => {
  const warnings = [];
  const orig = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    createTokenServer({ tokens: { a: 1 }, cors: true, watch: false }).close();
  } finally {
    console.error = orig;
  }
  assert.equal(warnings.filter((w) => /any origin to READ/.test(w)).length, 0);
});

test("a pinned cors origin with auth does not warn", async () => {
  const warnings = [];
  const orig = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    createTokenServer({
      tokens: { a: 1 },
      auth: { t: "read" },
      cors: "https://my.host",
      watch: false,
    }).close();
  } finally {
    console.error = orig;
  }
  assert.equal(warnings.filter((w) => /any origin to READ/.test(w)).length, 0);
});

test("a pinned cors origin still gets the full write surface", async () => {
  await withServer({ tokens: { a: 1 }, cors: "https://my.host" }, async (base) => {
    const res = await preflight(base);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://my.host");
    assert.match(res.headers.get("access-control-allow-methods"), /POST/);
    assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
  });
});

test("no cors configured means no CORS headers at all", async () => {
  await withServer({ tokens: { a: 1 } }, async (base) => {
    const res = await preflight(base);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

// ---------------------------------------------------------------------------
// the auth gate accepts only the exact token over HTTP
// ---------------------------------------------------------------------------

test("the serve auth gate accepts the exact bearer token and rejects near-misses", async () => {
  await withServer(
    { tokens: { a: 1 }, auth: { "secret-token": "read" } },
    async (base) => {
      const get = (bearer) =>
        fetch(base + "/tokens", bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});

      assert.equal((await get("secret-token")).status, 200);
      assert.equal((await get("secret-toke")).status, 401);
      assert.equal((await get("secret-tokenX")).status, 401);
      assert.equal((await get("secret")).status, 401);
      assert.equal((await get()).status, 401);
    }
  );
});

test("a read-scope token cannot POST", async () => {
  await withServer(
    { tokens: { a: 1 }, auth: { "read-tok": "read", "write-tok": "write" } },
    async (base) => {
      const post = (bearer) =>
        fetch(base + "/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ b: 2 }),
        });
      assert.equal((await post("read-tok")).status, 403, "read scope must not write");
      assert.equal((await post("read-tokX")).status, 401, "near-miss must not resolve");
      assert.equal((await post("write-tok")).status, 200);
    }
  );
});
