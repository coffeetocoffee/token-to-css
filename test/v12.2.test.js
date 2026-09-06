import test from "node:test";
import assert from "node:assert/strict";
import {
  createTokenServer,
  buildStaticPlayground,
  writeStaticPlayground,
  buildStaticCSS,
} from "../src/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKENS = {
  color: { primary: "#3b82f6", background: "#ffffff" },
  space: { md: "1rem" },
  modes: { dark: { color: { primary: "#93c5fd" } } },
};

// --- static-site build ------------------------------------------------------

test("v12.2: buildStaticPlayground emits a self-contained page", () => {
  const html = buildStaticPlayground();
  // Import map pins the CDN build of the browser-safe core.
  assert.match(html, /importmap/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/@token-to-css\/core@\d+\/\+esm/);
  // The client module is a real file next to index.html.
  assert.match(html, /<script type="module" src="\.\/playground\.js"><\/script>/);
  // The paste flow + editor + preview scaffolding is present.
  assert.match(html, /<textarea id="tokens"/);
  assert.match(html, /id="load"/);
  assert.match(html, /id="download"/);
  assert.match(html, /id="rows"/);
  assert.match(html, /id="ttc-css"/);
  // No server dependency anywhere in the page.
  assert.doesNotMatch(html, /createTokenServer|node:fs/);
});

test("v12.2: buildStaticPlayground accepts source text + config + cdnUrl", () => {
  const html = buildStaticPlayground({
    sourceText: '{"a":{"b":"1px"}}',
    config: { serveUrl: "http://localhost:4173", token: "sekrit" },
    cdnUrl: "https://example.test/core.mjs",
  });
  assert.match(html, /"a":\s*\{\s*"b":\s*"1px"/);
  assert.match(html, /"serveUrl":"http:\/\/localhost:4173"/);
  assert.match(html, /"token":"sekrit"/);
  assert.match(html, /https:\/\/example\.test\/core\.mjs/);
});

test("v12.2: static config never breaks out of the script tag", () => {
  const html = buildStaticPlayground({
    config: { token: '</script><script>alert(1)</script>' },
  });
  assert.doesNotMatch(html, /<\/script><script>alert/);
});

test("v12.2: writeStaticPlayground writes a deployable directory", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ttc-static-")), "site");
  const result = writeStaticPlayground(dir);
  assert.deepEqual(result.files, ["index.html", "playground.js"]);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const client = readFileSync(join(dir, "playground.js"), "utf8");
  assert.match(html, /<script type="module" src="\.\/playground\.js"><\/script>/);
  // The client imports the compiler by package name (resolved by the import map).
  assert.match(client, /from "@token-to-css\/core"/);
  // The client is browser code: no node: imports, no vscode.
  assert.doesNotMatch(client, /node:|require\(/);
  // Site-wide stylesheet helper feeds the page.
  assert.match(html, /#status\.err/);
  assert.ok(buildStaticCSS().includes("table{"));
  rmSync(dir, { recursive: true, force: true });
});

test("v12.2: playground --static CLI writes the site and exits", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(mkdtempSync(join(tmpdir(), "ttc-cli-")), "out");
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(here, "..", "src", "cli.js"), "playground", "--static", outDir],
      { stdio: "ignore" }
    );
    child.on("exit", resolve);
  });
  assert.equal(code, 0);
  assert.ok(readFileSync(join(outDir, "index.html"), "utf8").includes("playground"));
  rmSync(outDir, { recursive: true, force: true });
});

// --- browser-safe core ------------------------------------------------------

test("v12.2: core has no static node: imports outside federation", async () => {
  const { readdirSync, readFileSync: rf } = await import("node:fs");
  const { join: jp, dirname: dp } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const srcDir = jp(dp(dp(fileURLToPath(import.meta.url))), "packages", "core", "src");
  let offenders = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = jp(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".js")) {
        const text = rf(p, "utf8");
        if (text.includes('from "node:')) offenders.push(f.name);
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], "the core must stay browser-loadable: no static node: imports");
});

test("v12.2: federation lazily imports node: (pure functions still work)", async () => {
  const { validateManifest, mergeOrgRegistries } = await import("@token-to-css/core");
  const manifest = validateManifest({
    name: "org",
    teams: { core: { path: "./tokens.json", priority: 0 } },
  });
  assert.ok(manifest.teams.core.path.endsWith("tokens.json"));
  assert.ok(typeof mergeOrgRegistries === "function");
  // File-backed APIs throw a clear error in a browser-like env; here they run.
  const { buildNameRegistry, resolveReferences, normalizeW3C, convert } = await import(
    "@token-to-css/core"
  );
  const resolved = resolveReferences(normalizeW3C(TOKENS), { reduce: true });
  const css = convert(TOKENS, { format: "css" });
  assert.match(css, /--color-primary/);
  assert.ok(buildNameRegistry(TOKENS).pathOf("color-primary"));
});

// --- serve CORS (the static site's write path) ------------------------------

test("v12.2: serve --cors allows cross-origin reads and preflights", async () => {
  const server = createTokenServer({ tokens: TOKENS, watch: false, cors: true });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const preflight = await fetch(`${base}/tokens`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.github.io",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/i);

    const read = await fetch(`${base}/tokens`, { headers: { origin: "https://example.github.io" } });
    assert.equal(read.headers.get("access-control-allow-origin"), "*");
    assert.equal((await read.json()).color.primary, "#3b82f6");
  } finally {
    server.closeAll();
    server.close();
  }
});

test("v12.2: no cors option means no CORS headers (default unchanged)", async () => {
  const server = createTokenServer({ tokens: TOKENS, watch: false });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const read = await fetch(`${base}/tokens`, { headers: { origin: "https://example.github.io" } });
    assert.equal(read.headers.get("access-control-allow-origin"), null);
  } finally {
    server.closeAll();
    server.close();
  }
});

test("v12.2: cors + auth still enforce the write scope", async () => {
  const server = createTokenServer({
    tokens: TOKENS,
    watch: false,
    cors: true,
    auth: { "ro-token": "read", "rw-token": "write" },
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const post = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: {
        origin: "https://example.github.io",
        authorization: "Bearer ro-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ color: { primary: "#00ff00" } }),
    });
    assert.equal(post.status, 403);
    assert.match(await post.text(), /forbidden: write scope required/);
    assert.equal(post.headers.get("access-control-allow-origin"), "*");
    // Source untouched.
    const tree = await fetch(`${base}/tokens`, {
      headers: { authorization: "Bearer ro-token" },
    }).then((r) => r.json());
    assert.equal(tree.color.primary, "#3b82f6");

    const ok = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: {
        origin: "https://example.github.io",
        authorization: "Bearer rw-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ color: { primary: "#00ff00" } }),
    });
    assert.equal(ok.status, 200);
  } finally {
    server.closeAll();
    server.close();
  }
});

test("v12.2: cors can pin a single origin", async () => {
  const server = createTokenServer({
    tokens: TOKENS,
    watch: false,
    cors: "https://pages.example.org",
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const good = await fetch(`${base}/tokens`, { headers: { origin: "https://pages.example.org" } });
    assert.equal(good.headers.get("access-control-allow-origin"), "https://pages.example.org");
  } finally {
    server.closeAll();
    server.close();
  }
});
