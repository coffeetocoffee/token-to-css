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

test("CLI merges --glob files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const a = join(dir, "a.tokens.json");
    const b = join(dir, "b.tokens.json");
    writeFileSync(a, JSON.stringify({ color: { primary: "#111" } }));
    writeFileSync(b, JSON.stringify({ color: { bg: "#fff" } }));
    const out = execFileSync("node", [CLI, "--glob", join(dir, "*.tokens.json")], {
      encoding: "utf8",
    });
    assert.match(out, /--color-primary: #111;/);
    assert.match(out, /--color-bg: #fff;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI writes multiple outputs with per-output formats", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    const cssOut = join(dir, "out.css");
    const scssOut = join(dir, "out.scss");
    writeFileSync(input, JSON.stringify({ color: { primary: "#3b82f6" } }));
    execFileSync("node", [
      CLI,
      input,
      "-o",
      `css:${cssOut}`,
      "-o",
      `scss:${scssOut}`,
    ], { encoding: "utf8" });
    const css = readFileSync(cssOut, "utf8");
    const scss = readFileSync(scssOut, "utf8");
    assert.match(css, /--color-primary: #3b82f6;/);
    assert.match(scss, /\$color-primary: #3b82f6;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI writes a source map with --source-map", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    const cssOut = join(dir, "out.css");
    writeFileSync(input, JSON.stringify({ color: { primary: "#3b82f6" } }));
    execFileSync("node", [CLI, input, "-o", cssOut, "-M"], {
      encoding: "utf8",
    });
    const css = readFileSync(cssOut, "utf8");
    const map = JSON.parse(readFileSync(`${cssOut}.map`, "utf8"));
    assert.match(css, /\/\*# sourceMappingURL=out\.css\.map \*\//);
    assert.equal(map.version, 3);
    assert.ok(map.sources[0].endsWith("tokens.json"));
    assert.ok(map.mappings.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI accepts W3C design tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(
      input,
      JSON.stringify({ color: { primary: { $value: "#3b82f6" } } })
    );
    const out = execFileSync("node", [CLI, input], { encoding: "utf8" });
    assert.match(out, /--color-primary: #3b82f6;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI emits mode blocks with --mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(
      input,
      JSON.stringify({
        color: { primary: "#3b82f6" },
        modes: { dark: { color: { primary: "#111" } } },
      })
    );
    const out = execFileSync("node", [CLI, input, "--mode", "dark"], {
      encoding: "utf8",
    });
    assert.match(out, /:root\[data-mode="dark"\]/);
    assert.match(out, /--color-primary: #111;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI writes css-modules output", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    const out = join(dir, "out.css");
    writeFileSync(input, JSON.stringify({ color: { primary: "#3b82f6" } }));
    execFileSync("node", [CLI, input, "-o", `css-modules:${out}`], {
      encoding: "utf8",
    });
    const css = readFileSync(out, "utf8");
    assert.match(css, /:export \{/);
    assert.match(css, /colorPrimary: #3b82f6;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI writes json output", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    const out = join(dir, "out.json");
    writeFileSync(input, JSON.stringify({ color: { primary: "#3b82f6" } }));
    execFileSync("node", [CLI, input, "-o", `json:${out}`], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(parsed.color.primary, "#3b82f6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI applies the tailwind preset", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const input = join(dir, "tokens.json");
    writeFileSync(input, JSON.stringify({ color: { primary: "#3b82f6" } }));
    const out = execFileSync("node", [CLI, input, "--preset", "tailwind"], {
      encoding: "utf8",
    });
    assert.match(out, /--color-primary: #3b82f6;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI reads tokens from --stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-"));
  try {
    const out = join(dir, "out.css");
    execFileSync("node", [CLI, "--stdin", "-o", out], {
      input: JSON.stringify({ color: { primary: "#3b82f6" } }),
      encoding: "utf8",
    });
    const css = readFileSync(out, "utf8");
    assert.match(css, /--color-primary: #3b82f6;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

