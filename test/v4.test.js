import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convert,
  reverse,
  applyReversedIntoSource,
  computeDrift,
  canSetPath,
} from "../src/index.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), "ttc4-"));
}

const base = { color: { primary: "#3b82f6", text: "#0f172a" }, space: { md: "1rem" } };

// --- core sync logic ---

test("canSetPath rejects kebab collisions but allows clean paths", () => {
  const tree = { color: { primary: "#111" } };
  assert.equal(canSetPath(tree, "color-primary"), true);
  // color.primary is a leaf, so a nested color.primary-hover collides
  assert.equal(canSetPath(tree, "color-primary-hover"), false);
});

test("applyReversedIntoSource folds an external CSS edit back into tokens", () => {
  const css = convert(base, { format: "css" });
  const reversed = reverse(css);
  // simulate a designer editing the generated CSS value
  reversed.color.primary = "#111111";
  const { source, changed } = applyReversedIntoSource(base, reversed);
  assert.equal(source.color.primary, "#111111");
  assert.ok(changed.includes("color-primary"));
});

test("applyReversedIntoSource is idempotent (re-reversing regenerated CSS)", () => {
  const css = convert(base, { format: "css" });
  const once = applyReversedIntoSource(base, reverse(css));
  const twice = applyReversedIntoSource(once.source, reverse(css));
  assert.deepEqual(twice.source, once.source);
  assert.equal(twice.changed.length, 0);
});

test("applyReversedIntoSource skips colliding names instead of clobbering", () => {
  const src = { color: { primary: "#3b82f6" } };
  // a reversed artifact whose `color.primary-hover` would collide with the
  // existing `color.primary` leaf: it must be skipped, leaf preserved.
  const reversed = { color: { "primary-hover": "#2563eb" } };
  const { source, changed, skipped } = applyReversedIntoSource(src, reversed);
  assert.equal(source.color.primary, "#3b82f6");
  assert.equal(changed.length, 0);
  assert.ok(skipped.includes("color-primary-hover"));
});

test("computeDrift reports changed tokens between source and reversed artifact", () => {
  const css = convert(base, { format: "css" });
  const reversed = reverse(css);
  reversed.color.primary = "#999999";
  const drift = computeDrift(base, reversed);
  assert.equal(drift.base.changed["color-primary"].to, "#999999");
});

// --- CLI: sync end-to-end (spawn + external edit) ---

test("CLI sync reverse-merges an edited output back into the source", async () => {
  const dir = tmp();
  try {
    const input = join(dir, "tokens.json");
    const out = join(dir, "out.css");
    writeFileSync(input, JSON.stringify(base));
    const child = spawn("node", [CLI, "sync", input, "-o", out], { stdio: "ignore" });
    // wait for initial generation
    for (let i = 0; i < 40 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(out), "sync should generate the output");
    // let the watcher finish registering before simulating an external edit
    await new Promise((r) => setTimeout(r, 300));

    // now simulate an external edit to the CSS
    const edited = readFileSync(out, "utf8").replace("#3b82f6", "#abcdef");
    writeFileSync(out, edited);

    // poll for the source to be updated
    let updated = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const t = JSON.parse(readFileSync(input, "utf8"));
      if (t.color.primary === "#abcdef") {
        updated = true;
        break;
      }
    }
    child.kill();
    assert.ok(updated, "sync should have written the edited value back to tokens.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
