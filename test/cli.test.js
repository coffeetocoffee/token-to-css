import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI writes css output to a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    const output = join(dir, "out.css");
    writeFileSync(input, JSON.stringify({ color: { primary: "#3b82f6" } }));
    execFileSync("node", [CLI, input, "-o", output], { encoding: "utf8" });
    const result = readFileSync(output, "utf8");
    assert.match(result, /--color-primary: #3b82f6;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI supports the barefoot format", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(
      input,
      JSON.stringify({ color: { primary: "#000", background: "#fff" } })
    );
    const out = execFileSync(
      "node",
      [CLI, input, "-f", "barefoot", "-t", "demo"],
      { encoding: "utf8" }
    );
    assert.match(out, /\[data-bf-theme="demo"\] \{/);
    assert.match(out, /--bf-primary: #000;/);
    assert.match(out, /--bf-surface: #fff;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exits non-zero on invalid tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(input, JSON.stringify({ color: ["#000"] }));
    assert.throws(() =>
      execFileSync("node", [CLI, input], { encoding: "utf8" })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI merges --import files with main overriding", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const main = join(dir, "main.json");
    const extra = join(dir, "extra.json");
    writeFileSync(main, JSON.stringify({ color: { primary: "#222" } }));
    writeFileSync(extra, JSON.stringify({ color: { bg: "#fff" } }));
    const out = execFileSync("node", [CLI, main, "--import", extra], {
      encoding: "utf8",
    });
    assert.match(out, /--color-primary: #222;/);
    assert.match(out, /--color-bg: #fff;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI loads token-to-css.config.json for defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const main = join(dir, "tokens.json");
    const cfg = join(dir, "token-to-css.config.json");
    writeFileSync(main, JSON.stringify({ color: { primary: "#000" } }));
    writeFileSync(cfg, JSON.stringify({ format: "barefoot", theme: "cfg" }));
    const out = execFileSync("node", [CLI, main], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.match(out, /\[data-bf-theme="cfg"\] \{/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

