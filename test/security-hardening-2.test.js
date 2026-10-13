// Regression tests for three confirmed findings, each reproduced before fixing:
//
//   1. CRITICAL  An unclosed `{` in an expression made the tokenizer loop
//               forever (indexOf -> -1 reset the cursor to 0), growing the
//               token array until the heap died. Reachable from one
//               unauthenticated POST /tokens.
//   2. CRITICAL  serve never passed the route's team to the auth resolver, so
//               every team-scoped credential was an effective GLOBAL write
//               credential (an authorisation bypass on the team rooms).
//   3. CRITICAL  Change-request ids collided after a restart; approving the id
//               applied the OLD proposal to the source of truth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createNamespacedAuth,
  createOrgAuth,
  resolveReferences,
  createChangeRequest,
  seedChangeRequestIds,
} from "@token-to-css/core";
import { lintTokens } from "@token-to-css/core";
import { createTokenServer } from "../src/serve.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
// Absolute URL for the spawned subprocess to import (a bare relative path
// would resolve against the child's cwd, not this repo).
const SERVE_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "serve.js")
).href;

// ---------------------------------------------------------------------------
// 1. unclosed `{` must fail loudly, not OOM
// ---------------------------------------------------------------------------

test("an unclosed { throws immediately instead of looping until OOM", () => {
  // Every payload from the finding. Each contains "(" (so looksLikeExpr sends
  // it to the tokenizer) and an unclosed "{".
  const payloads = ["calc({spacing.base", "rgb({a", "(1px + {a", "calc(1px + 2px, {a"];
  for (const value of payloads) {
    const t0 = performance.now();
    assert.throws(
      () => resolveReferences({ spacing: { x: value } }, { reduce: true }),
      /unclosed token reference/,
      `expected a thrown error for ${JSON.stringify(value)}`
    );
    // The old code never returned (heap OOM, exit 134). A diagnostic is
    // immediate; this bound is a tripwire for a future regression to a hang.
    assert.ok(performance.now() - t0 < 1000, `too slow for ${JSON.stringify(value)}`);
  }
});

test("a partially valid expression still throws when a later { is unclosed", () => {
  assert.throws(
    () => resolveReferences({ a: "4px", x: "{a} * calc({a" }, { reduce: true }),
    /unclosed token reference/
  );
});

test("the tokenizer progress guard makes a stall unreachable for balanced input", () => {
  // Balanced braces across the whole string, including nesting and trailing
  // characters, must parse normally (the guard must never fire here).
  for (const value of [
    "{a}",
    "calc({a} * 2)",
    "({a} + {b}) * 2",
    "calc({a})",
    "linear-gradient(red, blue)",
    "rgba(0,0,0,0.5)",
  ]) {
    assert.doesNotThrow(
      () => resolveReferences({ a: "4px", b: "2px", x: value }, { reduce: true }),
      `balanced input must not throw: ${JSON.stringify(value)}`
    );
  }
});

test("an unclosed { is reported by lint as a distinct rule, not 'unknown-reference'", () => {
  const { issues } = lintTokens({ spacing: { x: "calc({spacing.base" } });
  const expr = issues.find((i) => i.rule === "invalid-expression");
  assert.ok(expr, `expected an invalid-expression issue, got: ${JSON.stringify(issues.map((i) => i.rule))}`);
  assert.match(expr.message, /unclosed token reference/);
});

test("CLI: an unclosed { exits non-zero with a message instead of 134 (OOM)", () => {
  const dir = mkdtempSync(join(tmpdir(), "t2c-unclosed-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(input, JSON.stringify({ spacing: { x: "calc({spacing.base" } }), "utf8");
    let status = 0;
    let stderr = "";
    try {
      // execFileSync throws on a non-zero exit; the child must NOT be killed
      // by an OOM abort, which is what the finding reported.
      execFileSync("node", [CLI, input, "-o", join(dir, "out.css")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr || "");
    }
    assert.notEqual(status, 0, "the CLI must fail");
    assert.notEqual(status, 134, "must not die from a heap OOM abort");
    assert.match(stderr, /unclosed token reference/);
  } finally {
    unlinkSync(join(dir, "tokens.json"));
  }
});

test("serve: an unclosed { is a 400 that leaves the server and tree intact", async () => {
  // The reported DoS: one unauthenticated POST killed the process (heap OOM).
  // It must now be a clean rejection, and the fold must not be half-applied.
  await withServer({ tokens: { spacing: { base: "1rem" } } }, async (base) => {
    const res = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spacing: { x: "calc({spacing.base" } }),
    });
    assert.equal(res.status, 400, "a malformed value is rejected, not applied");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /unclosed token reference/);

    const tree = await (await fetch(`${base}/tokens`)).json();
    assert.equal(tree.spacing.x, undefined, "the bad value must not be stored");
    const good = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spacing: { x: "2rem" } }),
    });
    assert.equal(good.status, 200, "a valid write still succeeds afterwards");
  });
});

// ---------------------------------------------------------------------------
// 2. team scoping: serve must pass the route's team to the resolver
// ---------------------------------------------------------------------------

async function withServer(options, fn) {
  const server = createTokenServer({ watch: false, ...options });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, server);
  } finally {
    if (server.closeAll) server.closeAll();
    server.close();
  }
}

const teamAuth = () =>
  createNamespacedAuth({
    tokens: {
      "core-write": { scope: "write", teams: ["core"] },
      "core-read": { scope: "read", teams: ["core"] },
      admin: { scope: "write", teams: ["*"] },
      legacy: { scope: "write" }, // no teams -> not team-scoped
    },
  });

const TEAM_TREE = { teams: { core: { a: "#111" }, web: { secret: "#222" } } };
const auth = (t) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

test("serve: a team-scoped token cannot write another team's room", async () => {
  await withServer({ tokens: structuredClone(TEAM_TREE), auth: teamAuth() }, async (base) => {
    const foreign = await fetch(`${base}/teams/web/tokens`, {
      method: "POST",
      headers: auth("core-write"),
      body: JSON.stringify({ injected: "#999" }),
    });
    assert.equal(foreign.status, 403, "a core token must not write the web room");
    const web = await (await fetch(`${base}/teams/web/tokens`, { headers: auth("admin") })).json();
    assert.equal(web.injected, undefined, "the foreign write must not land");
  });
});

test("serve: a team-scoped token cannot read another team's room", async () => {
  await withServer({ tokens: structuredClone(TEAM_TREE), auth: teamAuth() }, async (base) => {
    const foreign = await fetch(`${base}/teams/web/tokens`, { headers: auth("core-write") });
    assert.equal(foreign.status, 403);
  });
});

test("serve: a team-scoped token is denied on global routes (strict policy)", async () => {
  await withServer({ tokens: structuredClone(TEAM_TREE), auth: teamAuth() }, async (base) => {
    const post = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: auth("core-write"),
      body: JSON.stringify({ z: "#000" }),
    });
    assert.equal(post.status, 403, "a core-only token must not write the global tree");
    const get = await fetch(`${base}/tokens`, { headers: auth("core-write") });
    assert.equal(get.status, 403, "a core-only token must not read the global tree");
  });
});

test("serve: own-team access, wildcard tokens, and legacy tokens still work", async () => {
  await withServer({ tokens: structuredClone(TEAM_TREE), auth: teamAuth() }, async (base) => {
    assert.equal(
      (await fetch(`${base}/teams/core/tokens`, {
        method: "POST",
        headers: auth("core-write"),
        body: JSON.stringify({ ok: "#444" }),
      })).status,
      200,
      "a core token must be able to write its own room"
    );
    assert.equal(
      (await fetch(`${base}/teams/web/tokens`, {
        method: "POST",
        headers: auth("admin"),
        body: JSON.stringify({ adm: "#1" }),
      })).status,
      200,
      "a wildcard token must reach any room"
    );
    assert.equal(
      (await fetch(`${base}/tokens`, {
        method: "POST",
        headers: auth("admin"),
        body: JSON.stringify({ z: "#123" }),
      })).status,
      200,
      "a wildcard token must reach the global route"
    );
    assert.equal(
      (await fetch(`${base}/tokens`, {
        method: "POST",
        headers: auth("legacy"),
        body: JSON.stringify({ l: "#1" }),
      })).status,
      200,
      "a token with no teams list is not team-scoped and keeps working"
    );
  });
});

test("serve: an unknown token is still 401, not 403", async () => {
  await withServer({ tokens: structuredClone(TEAM_TREE), auth: teamAuth() }, async (base) => {
    assert.equal((await fetch(`${base}/tokens`, { headers: auth("nope") })).status, 401);
    assert.equal((await fetch(`${base}/teams/core/tokens`, { headers: auth("core-writ") })).status, 401);
  });
});

test("org-aware resolvers enforce the team dimension too", async () => {
  const orgAuth = createOrgAuth({
    tokens: {
      "b-write": { scope: "write", org: "b", teams: ["*"] },
      "b-web": { scope: "write", org: "b", teams: ["web"] },
      "a-write": { scope: "write", org: "a", teams: ["*"] },
    },
  });
  await withServer(
    { tokens: { teams: { web: { a: "#1" }, billing: { b: "#2" } } }, org: "b", auth: orgAuth },
    async (base) => {
      assert.equal(
        (await fetch(`${base}/tokens`, {
          method: "POST",
          headers: auth("a-write"),
          body: JSON.stringify({ x: "#999" }),
        })).status,
        403,
        "a foreign org must still be forbidden"
      );
      assert.equal(
        (await fetch(`${base}/teams/web/tokens`, {
          method: "POST",
          headers: auth("b-web"),
          body: JSON.stringify({ w: "#5" }),
        })).status,
        200,
        "a team token must write its own room"
      );
      assert.equal(
        (await fetch(`${base}/teams/billing/tokens`, {
          method: "POST",
          headers: auth("b-web"),
          body: JSON.stringify({ q: "#6" }),
        })).status,
        403,
        "a team token must not write a sibling room"
      );
      assert.equal(
        (await fetch(`${base}/tokens`, {
          method: "POST",
          headers: auth("b-web"),
          body: JSON.stringify({ y: "#7" }),
        })).status,
        403,
        "a team token must not write the global tree"
      );
    }
  );
});

// ---------------------------------------------------------------------------
// 3. change-request ids must not collide after a restart
// ---------------------------------------------------------------------------

test("seedChangeRequestIds advances the counter past reloaded ids", () => {
  const first = createChangeRequest({}, {}); // consumes the next id
  seedChangeRequestIds([{ id: first.id }, { id: "cr-999" }]);
  const next = createChangeRequest({}, {});
  assert.notEqual(next.id, first.id);
  assert.notEqual(next.id, "cr-999");
});

test("seedChangeRequestIds tolerates junk ids and a missing log", () => {
  assert.doesNotThrow(() => seedChangeRequestIds(undefined));
  assert.doesNotThrow(() => seedChangeRequestIds([]));
  assert.doesNotThrow(() => seedChangeRequestIds([{ id: "cr-abc" }, {}, { id: 5 }]));
});

test("a restarted server issues a fresh id and applies its own proposal", () => {
  // Two real processes against the same tokensPath + crLog, as reported.
  const dir = mkdtempSync(join(tmpdir(), "t2c-crid-"));
  const tokenFile = join(dir, "tokens.json");
  const crLog = join(dir, "tokens.json.crlog.json");
  writeFileSync(tokenFile, `${JSON.stringify({ a: "#000" }, null, 2)}\n`, "utf8");

  // Each phase must run in a SEPARATE process: the id counter is module state,
  // so a fresh process is what actually resets it to 1 (the reported bug).
  const phase = (value) => {
    const script = `
      import { createTokenServer } from ${JSON.stringify(SERVE_URL)};
      const server = createTokenServer({
        tokensPath: ${JSON.stringify(tokenFile)},
        watch: false,
        approve: true,
        crLog: ${JSON.stringify(crLog)},
      });
      await new Promise((r) => server.listen(0, r));
      const base = "http://127.0.0.1:" + server.address().port;
      const res = await fetch(base + "/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: ${JSON.stringify(value)} }),
      });
      const json = await res.json();
      process.stdout.write(json.cr.id);
      server.closeAll();
      server.close();
    `;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(out.status, 0, `phase failed: ${out.stderr}`);
    return out.stdout.trim();
  };

  const first = phase("#aaa");
  const second = phase("#bbb");
  assert.ok(first.startsWith("cr-"), `unexpected first id ${first}`);
  assert.notEqual(second, first, "a restarted server must not reuse an id");

  // Approve in a THIRD process and assert the NEW proposal was applied, not
  // the reloaded one that shared the id before the fix.
  const approve = `
    import { createTokenServer } from ${JSON.stringify(SERVE_URL)};
    const server = createTokenServer({
      tokensPath: ${JSON.stringify(tokenFile)},
      watch: false,
      approve: true,
      crLog: ${JSON.stringify(crLog)},
    });
    await new Promise((r) => server.listen(0, r));
    const base = "http://127.0.0.1:" + server.address().port;
    const res = await fetch(base + "/change-requests/" + ${JSON.stringify(second)} + "/approve", { method: "POST" });
    const json = await res.json();
    process.stdout.write(JSON.stringify({ status: res.status, proposed: json.cr && json.cr.proposed }));
    server.closeAll();
    server.close();
  `;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", approve], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(out.status, 0, `approve phase failed: ${out.stderr}`);
  const applied = JSON.parse(out.stdout);
  assert.equal(applied.status, 200);
  assert.equal(applied.proposed.a, "#bbb", "the NEW proposal must be applied");
  const source = JSON.parse(readFileSync(tokenFile, "utf8"));
  assert.equal(source.a, "#bbb", "the source of truth must hold the approved change");
});

test("an ambiguous (duplicated) change-request id is a 409, not a wrong write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t2c-ambig-"));
  const tokenFile = join(dir, "tokens.json");
  const crLog = join(dir, "tokens.json.crlog.json");
  writeFileSync(tokenFile, `${JSON.stringify({ a: "#000" }, null, 2)}\n`, "utf8");
  // A pre-fix log (or two writers to one file) can hold two cr-1 records.
  writeFileSync(
    crLog,
    JSON.stringify([
      { id: "cr-1", status: "pending", author: "a", reason: "", created: "", current: {}, proposed: { a: "#aaa" } },
      { id: "cr-1", status: "pending", author: "b", reason: "", created: "", current: {}, proposed: { a: "#bbb" } },
    ]),
    "utf8"
  );

  const server = createTokenServer({ tokensPath: tokenFile, watch: false, approve: true, crLog });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/change-requests/cr-1/approve`, { method: "POST" });
    assert.equal(res.status, 409, "a duplicated id must not resolve by first-match");
    const source = JSON.parse(readFileSync(tokenFile, "utf8"));
    assert.equal(source.a, "#000", "the source must be untouched on ambiguity");
  } finally {
    server.closeAll();
    server.close();
  }
});