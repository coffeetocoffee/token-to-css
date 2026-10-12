import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJSONText } from "../packages/core/src/index.js";
import { buildOrgManifest } from "../packages/core/src/federation.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const BOM = String.fromCharCode(0xfeff);
const TOKENS = { color: { primary: "#3b82f6" } };

test("parseJSONText strips a leading UTF-8 BOM and parses the rest", () => {
  assert.deepEqual(parseJSONText(BOM + JSON.stringify(TOKENS)), TOKENS);
  assert.deepEqual(parseJSONText(JSON.stringify(TOKENS)), TOKENS);
});

test("parseJSONText still rejects genuinely invalid JSON", () => {
  assert.throws(() => parseJSONText(BOM + "{not json"), SyntaxError);
});

test("CLI builds a BOM-prefixed token file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-bom-cli-"));
  try {
    const input = join(dir, "t.json");
    const out = join(dir, "o.css");
    writeFileSync(input, BOM + JSON.stringify(TOKENS), "utf8");
    execFileSync("node", [CLI, input, "-o", out], { encoding: "utf8" });
    assert.match(readFileSync(out, "utf8"), /--color-primary: #3b82f6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("federation manifest loads from a BOM-prefixed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttc-bom-fed-"));
  try {
    const manifest = join(dir, "org.json");
    writeFileSync(
      manifest,
      BOM + JSON.stringify({ org: "acme", teams: [] }),
      "utf8"
    );
    assert.ok(existsSync(manifest));
    assert.doesNotThrow(() => buildOrgManifest(manifest));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
