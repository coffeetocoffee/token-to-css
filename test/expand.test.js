import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("expand glob mode: basic pattern expansion", () => {
  const dir = mkdtemp("ttc-expand-");
  try {
    // Create multiple token files
    writeFileSync(join(dir, "a.json"), JSON.stringify({ color: { primary: "#111" } }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ spacing: { md: "1rem" } }));
    
    // Expand glob pattern
    const out = execFileSync("node", [CLI, "expand", join(dir, "*.json")], { encoding: "utf8" });
    assert.ok(out.includes("a.json"));
    assert.ok(out.includes("b.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expand glob mode: --json output", () => {
  const dir = mkdtemp("ttc-expand-");
  try {
    writeFileSync(join(dir, "x.json"), JSON.stringify({ foo: "bar" }));
    writeFileSync(join(dir, "y.json"), JSON.stringify({ baz: "qux" }));
    
    const out = execFileSync(
      "node",
      [CLI, "expand", join(dir, "*.json"), "--json"],
      { encoding: "utf8" }
    );
    const json = JSON.parse(out);
    assert.equal(json.paths.length, 2);
    assert.ok(json.paths.some((p) => p.endsWith("x.json")));
    assert.ok(json.paths.some((p) => p.endsWith("y.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expand glob mode: --deep groups by directory", () => {
  const dir = mkdtemp("ttc-expand-deep-");
  try {
    mkdirSync(join(dir, "colors"));
    mkdirSync(join(dir, "spacing"));
    writeFileSync(join(dir, "base.json"), JSON.stringify({ base: "1px" }));
    writeFileSync(join(dir, "colors.json"), JSON.stringify({ colors: ["#fff"] }));
    writeFileSync(join(dir, "colors/theme.json"), JSON.stringify({ theme: "light" }));
    writeFileSync(join(dir, "spacing/base.json"), JSON.stringify({ base: "0.5rem" }));
    
    const out = execFileSync(
      "node",
      [CLI, "expand", join(dir, "**/*.json"), "--deep", "--json"],
      { encoding: "utf8" }
    );
    const json = JSON.parse(out);
    // Should have 3 groups: root (.), colors/, spacing/
    assert.equal(json.groups.length, 3);
    // Check group structure
    const rootGroup = json.groups.find((g) => g.dir === ".");
    const colorsGroup = json.groups.find((g) => g.dir === "colors");
    const spacingGroup = json.groups.find((g) => g.dir === "spacing");
    
    assert.ok(rootGroup);
    assert.ok(colorsGroup);
    assert.ok(spacingGroup);
    
    // Root should have base.json and colors.json
    assert.ok(rootGroup.files.some((f) => f.endsWith("base.json")));
    assert.ok(rootGroup.files.some((f) => f.endsWith("colors.json")));
    
    // Colors group should have theme.json
    assert.ok(colorsGroup.files.some((f) => f.endsWith("theme.json")));
    
    // Spacing group should have base.json
    assert.ok(spacingGroup.files.some((f) => f.endsWith("base.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expand refs mode: single token resolution with trace", () => {
  const dir = mkdtemp("ttc-expand-refs-");
  try {
    writeFileSync(
      join(dir, "tokens.json"),
      JSON.stringify({
        color: { primary: "#3b82f6", hover: "{color.primary}" },
        spacing: { md: "1rem", lg: "{spacing.md} * 2" }
      })
    );
    
    // Get full tree resolved
    const out = execFileSync(
      "node",
      [CLI, "expand", "--refs", join(dir, "tokens.json"), "--json"],
      { encoding: "utf8" }
    );
    const json = JSON.parse(out);
    assert.strictEqual(json.color.hover, "#3b82f6");
    assert.strictEqual(json.spacing.lg, "2rem");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expand refs mode: --path filter shows trace", () => {
  const dir = mkdtemp("ttc-expand-refspath-");
  try {
    writeFileSync(
      join(dir, "tokens.json"),
      JSON.stringify({
        color: { primary: "#3b82f6", hover: "{color.primary}" }
      })
    );
    
    const out = execFileSync(
      "node",
      [CLI, "expand", "--refs", join(dir, "tokens.json"), "--path", "color.hover", "--json"],
      { encoding: "utf8" }
    );
    const json = JSON.parse(out);
    assert.strictEqual(json.path, "color.hover");
    assert.strictEqual(json.raw, "{color.primary}");
    assert.strictEqual(json.resolved, "#3b82f6");
    assert.equal(json.refs.length, 1);
    assert.strictEqual(json.refs[0].ref, "color.primary");
    assert.strictEqual(json.refs[0].resolved, "#3b82f6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expand preview mode: per-file token summary", () => {
  const dir = mkdtemp("ttc-expand-preview-");
  try {
    writeFileSync(join(dir, "colors.json"), JSON.stringify({ color: { primary: "#111" } }));
    writeFileSync(join(dir, "spacing.json"), JSON.stringify({ spacing: { md: "1rem" } }));
    
    // Human-readable preview
    const out = execFileSync(
      "node",
      [CLI, "expand", "--preview", join(dir, "colors.json"), "--glob", join(dir, "spacing.json")],
      { encoding: "utf8" }
    );
    assert.ok(out.includes("colors.json"));
    assert.ok(out.includes("spacing.json"));
    assert.ok(out.includes("Total:"));
    
    // JSON preview
    const jsonOut = execFileSync(
      "node",
      [CLI, "expand", "--preview", join(dir, "colors.json"), "--glob", join(dir, "spacing.json"), "--json"],
      { encoding: "utf8" }
    );
    const json = JSON.parse(jsonOut);
    assert.ok(json.files.length >= 2);
    assert.ok(typeof json.totalTokens === "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expand --cwd option sets base directory", () => {
  const dir = mkdtemp("ttc-expand-cwd-");
  const subdir = join(dir, "sub");
  mkdirSync(subdir);
  try {
    writeFileSync(join(subdir, "data.json"), JSON.stringify({ x: 1 }));
    
    // Run from parent dir, specify subdir as cwd
    const out = execFileSync(
      "node",
      [CLI, "expand", "*", "--cwd", subdir, "--json"],
      { encoding: "utf8" }
    );
    const json = JSON.parse(out);
    assert.ok(json.paths.some((p) => p.endsWith("data.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Helper function
function mkdtemp(prefix) {
  const dir = join(tmpdir(), prefix + Math.random().toString(36).slice(2, 7));
  mkdirSync(dir, { recursive: true });
  return dir;
}
