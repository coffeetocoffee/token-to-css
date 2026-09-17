import test from "node:test";
import assert from "node:assert/strict";
import { createTokenServer } from "../src/serve.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Generate a ~10k-token tree for the scale acceptance criterion.
function makeBigTokens(n = 10000) {
  const tree = {};
  let made = 0;
  let g = 0;
  while (made < n) {
    const group = `group${g}`;
    tree[group] = {};
    for (let i = 0; i < 200 && made < n; i++) {
      const hex = ((i * 7 + g * 13) % 0xffffff).toString(16).padStart(6, "0");
      tree[group][`token${i}`] = `#${hex}`;
      made++;
    }
    g++;
  }
  return tree;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, resolve));
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  return res.json();
}

// --- v13: serve under load — incremental completions stay fast at org scale ----

test("v13: /completions over 10k tokens completes in <50ms warm", async (t) => {
  const server = createTokenServer({
    tokens: makeBigTokens(10000),
    port: 0,
    watch: false,
  });
  await listen(server);
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Prime: first call builds the cached language index.
  await getJson(base, "/completions?prefix=group0&kind=css&max=50");

  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const out = await getJson(base, "/completions?prefix=group0&kind=css&max=50");
    runs.push(performance.now() - t0);
    assert.ok(out.completions.length > 0, "expected matching completions");
    assert.equal(out.completions[0].variable, "--group0-token0");
  }
  const worst = Math.max(...runs);
  assert.ok(
    worst < 50,
    `warm /completions took ${worst.toFixed(2)}ms, expected < 50ms`
  );
});

test("v13: /completions ref kind returns {dotted} labels", async (t) => {
  const server = createTokenServer({
    tokens: makeBigTokens(2000),
    port: 0,
    watch: false,
  });
  await listen(server);
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = await getJson(base, "/completions?prefix=group1.token&kind=ref&max=10");
  assert.ok(out.completions.length > 0);
  assert.ok(out.completions[0].label.startsWith("{group1.token"));
});

// --- v13: /metrics exposes the observability surface -------------------------

test("v13: /metrics scrapes CR / subscriber / fold-latency / adoption gauges", async (t) => {
  const server = createTokenServer({
    tokens: makeBigTokens(500),
    port: 0,
    watch: false,
  });
  await listen(server);
  t.after(() => {
    server.closeAll();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Open an SSE subscription so the subscriber gauge has a non-zero value.
  const ac = new AbortController();
  const sse = fetch(`${base}/events`, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 50));

  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(text, /# TYPE token_to_css_subscribers gauge/);
  assert.match(text, /token_to_css_subscribers \d+/);
  assert.match(text, /# TYPE token_to_css_change_requests_pending gauge/);
  assert.match(text, /# TYPE token_to_css_token_count gauge/);
  assert.match(text, /token_to_css_token_count \d+/);
  assert.match(text, /# TYPE token_to_css_adoption_score gauge/);

  // Fold latency is recorded after a write (histogram only appears post-fold).
  await fetch(`${base}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ group0: { token0: "#000000" } }),
  });
  const text2 = await (await fetch(`${base}/metrics`)).text();
  assert.match(text2, /# TYPE token_to_css_fold_latency_seconds histogram/);
  assert.match(text2, /token_to_css_fold_latency_seconds_bucket/);
  assert.match(text2, /token_to_css_fold_latency_seconds_count [1-9]/);

  ac.abort();
  await sse.catch(() => {});
});

test("v13: non-blocking SSE fan-out survives hundreds of subscribers", async (t) => {
  const server = createTokenServer({
    tokens: makeBigTokens(500),
    port: 0,
    watch: false,
  });
  await listen(server);
  t.after(() => {
    server.closeAll();
    server.close();
  });

  // Inject synthetic subscribers (no real OS sockets) to exercise fan-out at
  // scale deterministically — the sandbox caps concurrent localhost connections,
  // and the broadcast loop iterates the same Set regardless of socket vs fake.
  const N = 300;
  const written = [];
  const fakes = [];
  for (let i = 0; i < N; i++) {
    const fake = {
      _buf: "",
      write(chunk) {
        this._buf += chunk;
        written.push(i);
        return true;
      },
      end() {},
      on() {},
    };
    fakes.push(fake);
    server.addSubscriber(fake);
  }
  assert.equal(
    server.metrics.get("token_to_css_subscribers"),
    N,
    "subscriber gauge reflects synthetic fan-out"
  );

  // A broadcast must reach every subscriber without throwing or blocking.
  assert.doesNotThrow(() => server.broadcast({ type: "update", tree: server.snapshotTree() }));

  // Writes are scheduled off the hot path; after a tick every subscriber has
  // received the broadcast.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(written.length, N, "every subscriber received the broadcast");
  const total = fakes.reduce(
    (n, f) => n + (f._buf.match(/data:/g) ? f._buf.match(/data:/g).length : 0),
    0
  );
  assert.ok(total >= N, "all scheduled writes delivered");

  for (const f of fakes) server.removeSubscriber(f);
  assert.equal(server.metrics.get("token_to_css_subscribers"), 0, "gauge clears on disconnect");
});

// --- v13: CR audit trail survives a restart ----------------------------------

test("v13: change-request audit log persists and reloads across a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "t2c-cr-"));
  const tokenFile = join(dir, "tokens.json");
  const crLog = join(dir, "tokens.json.crlog.json");
  writeFileSync(tokenFile, `${JSON.stringify({ color: { primary: "#3b82f6" } }, null, 2)}\n`, "utf8");

  const s1 = createTokenServer({ tokensPath: tokenFile, port: 0, watch: false, approve: true });
  await listen(s1);
  const base1 = `http://127.0.0.1:${s1.address().port}`;
  const res = await fetch(`${base1}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: { primary: "#22d3ee" } }),
  });
  assert.equal(res.status, 202, "approval mode returns 202");
  const crs1 = await getJson(base1, "/change-requests");
  assert.equal(crs1.length, 1, "one CR queued");
  assert.ok(existsSync(crLog), "CR log file written");
  // The log carries approver/timestamp/proposal for bisect & governance replay.
  const log = JSON.parse(readFileSync(crLog, "utf8"));
  assert.equal(log[0].proposed.color.primary, "#22d3ee");
  assert.ok(log[0].created, "CR timestamp present");
  s1.closeAll();
  s1.close();

  // Restart against the same tokens + log path: the CR must be reloaded.
  const s2 = createTokenServer({ tokensPath: tokenFile, port: 0, watch: false, approve: true });
  await listen(s2);
  t.after(() => {
    s2.closeAll();
    s2.close();
  });
  const base2 = `http://127.0.0.1:${s2.address().port}`;
  const crs2 = await getJson(base2, "/change-requests");
  assert.equal(crs2.length, 1, "CR reloaded from disk");
  assert.equal(crs2[0].status, "pending");

  // Approving persists the new status.
  await fetch(`${base2}/change-requests/${crs2[0].id}/approve`, { method: "POST" });
  const logAfter = JSON.parse(readFileSync(crLog, "utf8"));
  assert.equal(logAfter[0].status, "approved");

  unlinkSync(tokenFile);
  unlinkSync(crLog);
});

// --- v13: adoption dashboard report renders an HTML charts page ----------------

test("v13: buildAdoptionReport renders a charts page with bars", async (t) => {
  const { buildAdoptionReport } = await import("../src/adopt.js");
  const html = buildAdoptionReport(
    {
      orgs: {
        acme: {
          org: { score: 82, adopted: 41, hardcoded: 9 },
          teams: {
            web: { score: 90, adopted: 27, hardcoded: 3 },
            mobile: { score: 70, adopted: 14, hardcoded: 6 },
          },
        },
      },
      combined: { score: 82, adopted: 41, hardcoded: 9 },
    },
    { title: "Adoption" }
  );
  assert.match(html, /<svg/);
  assert.match(html, /Adoption/);
  assert.match(html, /acme\/web/);
  assert.match(html, /combined/);
});
