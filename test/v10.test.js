import { test } from "node:test";
import assert from "node:assert/strict";
import {
  release,
  classifyRelease,
  bumpVersion,
  generateChangelog,
  semverSatisfies,
  analyzeLockfile,
  bisectToken,
  renderSideBySide,
  createTokenServer,
} from "../src/index.js";

const prev = { color: { primary: "#3b82f6", old: "#000000" }, space: { md: "1rem" } };
const next = { color: { primary: "#2563eb" }, space: { md: "1rem" }, radius: { sm: "4px" } };

test("classifyRelease: removal -> major, change -> minor, add -> patch", () => {
  assert.equal(classifyRelease(prev, next).bump, "major");
  assert.equal(classifyRelease(prev, { ...prev, radius: { sm: "4px" } }).bump, "patch");
  assert.equal(classifyRelease(prev, { ...prev, color: { ...prev.color, primary: "#000" } }).bump, "minor");
  assert.equal(classifyRelease(prev, structuredClone(prev)).bump, "none");
});

test("bumpVersion computes the next semver", () => {
  assert.equal(bumpVersion("2.3.0", "major"), "3.0.0");
  assert.equal(bumpVersion("2.3.0", "minor"), "2.4.0");
  assert.equal(bumpVersion("2.3.0", "patch"), "2.3.1");
  assert.equal(bumpVersion("2.3.0", "none"), "2.3.0");
});

test("release end-to-end classifies deterministically and emits a changelog", () => {
  const r = release(prev, next, { version: "2.3.0" });
  assert.equal(r.bump, "major");
  assert.equal(r.nextVersion, "3.0.0");
  assert.match(r.changelog, /## 3\.0\.0/);
  assert.match(r.changelog, /### Removed \(BREAKING\)/);
  assert.match(r.changelog, /`color-old`/);
  assert.match(r.changelog, /### Changed/);
  assert.match(r.changelog, /### Added/);
});

test("generateChangelog renders sections", () => {
  const md = generateChangelog("1.1.0", { removed: [], changed: ["space-md"], added: ["radius-sm"] }, { prevVersion: "1.0.0" });
  assert.match(md, /## 1\.1\.0 — 1\.0\.0 → 1\.1\.0/);
  assert.match(md, /`space-md`/);
});

test("semverSatisfies handles ^, ~, exact, >=, and wildcards", () => {
  assert.equal(semverSatisfies("2.9.0", "^2.3"), true);
  assert.equal(semverSatisfies("3.0.0", "^2.3"), false);
  assert.equal(semverSatisfies("2.3.9", "~2.3"), true);
  assert.equal(semverSatisfies("2.4.0", "~2.3"), false);
  assert.equal(semverSatisfies("1.2.3", "1.2.3"), true);
  assert.equal(semverSatisfies("1.2.4", "1.2.3"), false);
  assert.equal(semverSatisfies("2.0.0", ">=1.0.0"), true);
  assert.equal(semverSatisfies("0.9.0", ">=1.0.0"), false);
  assert.equal(semverSatisfies("9.9.9", "*"), true);
});

test("analyzeLockfile fails a consumer pinned out of range and lists affected usages", () => {
  const lock = { name: "app", range: "^2.3", uses: ["color.old", "color.primary", "space.md"] };
  const res = analyzeLockfile(lock, prev, next, "3.0.0");
  assert.equal(res.inRange, false);
  assert.equal(res.ok, false);
  const paths = res.breaking.map((b) => b.path);
  assert.ok(paths.includes("color-old"), "removed token flagged");
  assert.ok(paths.includes("color-primary"), "changed token flagged");
  assert.ok(!paths.includes("space-md"), "unchanged token not flagged");
});

test("analyzeLockfile passes an in-range consumer with no removals", () => {
  const lock = { name: "app", range: "^2.3", uses: ["space.md"] };
  const res = analyzeLockfile(lock, prev, { ...prev, space: { md: "2rem" } }, "2.4.0");
  assert.equal(res.inRange, true);
  assert.equal(res.ok, true);
});

test("bisectToken finds the checkpoint that flipped a value", () => {
  const cps = [
    { id: "c1", tree: { color: { primary: "#111" } } },
    { id: "c2", tree: { color: { primary: "#111" } } },
    { id: "c3", tree: { color: { primary: "#222" } } },
    { id: "c4", tree: { color: { primary: "#222" } } },
  ];
  const r = bisectToken(cps, "color.primary");
  assert.equal(r.found, true);
  assert.equal(r.id, "c3");
  assert.equal(r.from, "#111");
  assert.equal(r.to, "#222");
  assert.match(renderSideBySide("color.primary", r.from, r.to), /before: #111/);
});

test("bisectToken reports no change when the value is stable", () => {
  const cps = [
    { id: "c1", tree: { color: { primary: "#111" } } },
    { id: "c2", tree: { color: { primary: "#111" } } },
  ];
  assert.equal(bisectToken(cps, "color.primary").found, false);
});

// --- serve release channels ---

function makeSSE(url) {
  const events = [];
  let waiter = null;
  const push = (ev) => {
    events.push(ev);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };
  (async () => {
    const res = await fetch(url);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) push(JSON.parse(line.slice(6)));
      }
    }
  })();
  return {
    async next(timeoutMs = 500) {
      if (events.length) return events.shift();
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          waiter = null;
          resolve();
        }, timeoutMs);
        waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      return events.length ? events.shift() : null;
    },
  };
}

test("serve channels: canary receives a change before promotion; stable sees it only after promote", async () => {
  const server = createTokenServer({
    tokens: { color: { primary: "#stable" } },
    channels: { canary: { color: { primary: "#canary" } } },
    watch: false,
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = "http://localhost:" + port;
  try {
    // GET /tokens?channel=canary differs from stable.
    const stable = await (await fetch(base + "/tokens")).json();
    const canary = await (await fetch(base + "/tokens?channel=canary")).json();
    assert.equal(stable.color.primary, "#stable");
    assert.equal(canary.color.primary, "#canary");

    // Subscribe to both channels.
    const canarySSE = makeSSE(base + "/events?channel=canary");
    const stableSSE = makeSSE(base + "/events");
    await canarySSE.next(); // initial snapshot
    await stableSSE.next(); // initial snapshot

    // Push a change to canary only.
    await fetch(base + "/tokens?channel=canary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: { primary: "#canary2" } }),
    });

    const canaryEvent = await canarySSE.next(800);
    assert.ok(canaryEvent && canaryEvent.channel === "canary", "canary subscriber gets the update");
    assert.equal(canaryEvent.tree.color.primary, "#canary2");

    const stableEvent = await stableSSE.next(300);
    assert.equal(stableEvent, null, "stable subscriber sees nothing before promotion");

    // Promote canary -> stable.
    await fetch(base + "/promote", { method: "POST" });
    const promoted = await stableSSE.next(800);
    assert.ok(promoted && promoted.channel === "stable", "stable subscriber gets the promotion");
    assert.equal(promoted.tree.color.primary, "#canary2");
  } finally {
    server.closeAll();
    server.close();
  }
});

// --- CLI ---

test("CLI: release classifies a diff and prints the bump", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc-rel-"));
  try {
    writeFileSync(join(dir, "prev.json"), JSON.stringify(prev));
    writeFileSync(join(dir, "next.json"), JSON.stringify(next));
    const out = execFileSync("node", [CLI, "release", join(dir, "prev.json"), join(dir, "next.json"), "--version", "2.3.0"], { encoding: "utf8", cwd: dir });
    assert.match(out, /bump: major/);
    assert.match(out, /next version: 3\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: lock fails a consumer pinned out of range", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc-lock-"));
  try {
    writeFileSync(join(dir, "lock.json"), JSON.stringify({ name: "app", range: "^2.3", uses: ["color.old"] }));
    writeFileSync(join(dir, "prev.json"), JSON.stringify(prev));
    writeFileSync(join(dir, "next.json"), JSON.stringify(next));
    let threw = false;
    try {
      execFileSync("node", [CLI, "lock", join(dir, "lock.json"), join(dir, "prev.json"), join(dir, "next.json"), "--version", "3.0.0"], { encoding: "utf8", cwd: dir });
    } catch (e) {
      threw = true;
      assert.equal(e.status, 1);
      assert.match(e.stdout || "", /removed: color-old/);
    }
    assert.ok(threw, "lock exits 1 on breaking change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: bisect walks checkpoints to the flipping change", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ttc-bis-"));
  try {
    const cp = join(dir, "cp");
    mkdirSync(cp);
    writeFileSync(join(cp, "01.json"), JSON.stringify({ color: { primary: "#111" } }));
    writeFileSync(join(cp, "02.json"), JSON.stringify({ color: { primary: "#111" } }));
    writeFileSync(join(cp, "03.json"), JSON.stringify({ color: { primary: "#222" } }));
    const out = execFileSync("node", [CLI, "bisect", "color.primary", "--checkpoints", cp], { encoding: "utf8", cwd: dir });
    assert.match(out, /changed at 03\.json/);
    assert.match(out, /before: #111/);
    assert.match(out, /after:  #222/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
