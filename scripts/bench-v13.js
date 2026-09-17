// Performance CI benchmark for the v13 scale/observability acceptance criteria.
// Guards the `convert` / `resolveReferences` hot paths and the incremental
// `/completions` endpoint with a 10k-token fixture. Run per PR; exits non-zero
// on regression so releases fail in CI, not in production.
//
//   node scripts/bench-v13.js
//
// Override the warm-completions budget with BUDGET_MS (default 50).

import { createTokenServer } from "../src/serve.js";
import { convert, resolveReferences, normalizeW3C } from "@token-to-css/core";

const BUDGET_MS = Number(process.env.BUDGET_MS || 50);
const TOKEN_COUNT = 10000;

function makeBigTokens(n) {
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

function time(fn, iters = 1) {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name} (${detail})`);
  } else {
    console.error(`  FAIL ${name} (${detail})`);
    failures++;
  }
}

async function main() {
  const tokens = makeBigTokens(TOKEN_COUNT);
  console.log(`benchmark fixture: ${TOKEN_COUNT} tokens`);

  // convert() hot path (the compiler core).
  const convertMs = time(() => convert(tokens, { format: "css" }));
  check(
    "convert() over 10k tokens",
    convertMs < 250,
    `${convertMs.toFixed(1)}ms`
  );

  // resolveReferences() hot path.
  const resolveMs = time(() => resolveReferences(normalizeW3C(tokens), { reduce: true }));
  check(
    "resolveReferences() over 10k tokens",
    resolveMs < 250,
    `${resolveMs.toFixed(1)}ms`
  );

  // Incremental /completions over a live server (warm).
  const server = createTokenServer({ tokens, port: 0, watch: false });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // prime (builds the cached index)
  await fetch(`${base}/completions?prefix=group0&max=50`);
  const warm = await (async () => {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await fetch(`${base}/completions?prefix=group0&max=50`);
      samples.push(performance.now() - t0);
    }
    return Math.max(...samples);
  })();
  check(
    "warm /completions over 10k tokens",
    warm < BUDGET_MS,
    `${warm.toFixed(2)}ms < ${BUDGET_MS}ms budget`
  );
  server.closeAll();
  server.close();

  console.log(failures === 0 ? "\nbench: PASS" : `\nbench: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
