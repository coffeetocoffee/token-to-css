// Regression tests for the security review: playground XSS, editor review-panel
// XSS, request-body DoS, and the looksLikeExpr ReDoS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenServer, MAX_BODY_BYTES } from "../src/serve.js";
import { buildEditorHTML } from "../src/editor.js";
import { convert } from "@token-to-css/core";

const EVIL = "</style><script>document.title='PWNED'</script><style>";

async function withServer(options, fn) {
  const server = createTokenServer({ watch: false, ...options });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server);
  } finally {
    server.closeAll();
    server.close();
  }
}

test("playground: a value containing </style> cannot close the style element", async () => {
  const tokens = { color: { evil: EVIL, ok: "#fff" } };
  await withServer({ tokens, playground: true }, async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes("--color-ok"), "page must contain the generated CSS (non-vacuous)");
    assert.ok(!html.includes(EVIL), "raw payload must not appear in the page");
    assert.ok(!/<\/style>\s*<script/i.test(html.replace(/<\/style>\s*<\/head>/i, "")), "no injected script after style");
    // Exactly one style block opens and closes around the CSS.
    const styleClose = (html.match(/<\/style>/gi) || []).length;
    assert.equal(styleClose, 1, "the only </style> is the real closing tag");
  });
});

test("playground: mode and brand option values are escaped", async () => {
  const tokens = {
    color: { primary: "#000" },
    modes: { 'dark"><img src=x onerror=alert(1)>': { color: { primary: "#111" } } },
    brands: { "<script>x</script>": { color: { primary: "#222" } } },
  };
  await withServer({ tokens, playground: true }, async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes('<option value="dark'), "option markup present (non-vacuous)");
    assert.ok(!html.includes("<img src=x"), "mode name must not inject an element");
    assert.ok(!html.includes("<script>x</script>"), "brand name must not inject a script");
  });
});

test("playground: the page script renders token data via textContent, not innerHTML", async () => {
  await withServer({ tokens: { color: { a: "#fff" } }, playground: true }, async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    const renderSrc = html.slice(html.indexOf("function render("), html.indexOf("client.on(render)"));
    assert.ok(!/innerHTML/.test(renderSrc), "render() must not assign innerHTML");
    assert.ok(/textContent/.test(renderSrc), "render() must use textContent");
  });
});

test("editor review panel escapes token values before innerHTML", () => {
  const html = buildEditorHTML({ color: { primary: "#000" } }, { editable: true });
  // The panel script must define an escaper and route fields through it.
  assert.ok(html.includes("var esc = function(s)"), "panel escaper present");
  const panel = html.slice(html.indexOf("function showPanel("), html.indexOf("panel.innerHTML = out;"));
  // Each interpolated changed-field goes through esc(...).
  assert.ok(/esc\(p\.changed\.from\)/.test(panel));
  assert.ok(/esc\(d\.added\[k\]\)/.test(panel), "added diff value is escaped");
  assert.ok(/esc\(k\)/.test(panel), "diff keys are escaped");
  assert.ok(!/" \+ p\.changed\.from/.test(panel), "no raw concatenation of changed.from");
});

test("POST /tokens rejects a body over the cap with 413", async () => {
  await withServer({ tokens: { color: { a: "#fff" } } }, async (base) => {
    const big = "x".repeat(MAX_BODY_BYTES + 1024);
    const res = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: { a: big } }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.ok, false);
  });
});

test("POST /tokens still accepts a normal-sized body", async () => {
  await withServer({ tokens: { color: { a: "#fff" } } }, async (base) => {
    const res = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: { a: "#000" } }),
    });
    assert.notEqual(res.status, 413);
  });
});

test("long unbroken token values convert in linear time (no ReDoS)", () => {
  const big = "z".repeat(64 * 1024);
  const t0 = performance.now();
  const css = convert({ font: { body: big } }, { format: "css" });
  const ms = performance.now() - t0;
  assert.ok(css.includes("--font-body"));
  assert.ok(ms < 500, `64 KB value took ${ms.toFixed(1)}ms; expected linear time`);
});

test("expression detection still resolves references and function calls", () => {
  const css = convert(
    { color: { base: "#3b82f6", soft: "alpha({color.base}, 50%)" }, space: { md: "1rem", lg: "{space.md} * 2" } },
    { format: "css" }
  );
  assert.ok(css.includes("--space-lg:"), "reference arithmetic still emitted");
  assert.ok(css.includes("--color-soft:") && !css.includes("alpha("), "function call still evaluated");
});
