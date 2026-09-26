import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFiles } from "../scripts/check-syntax.js";
import { parseLcov, evaluate, THRESHOLDS } from "../scripts/check-coverage.js";
import {
  declaredValueNames,
  declaredTypeNames,
  compare,
} from "../scripts/check-declarations.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "ttc-gate-"));
}

// ---------------------------------------------------------------------------
// the syntax gate must CATCH things, not just pass
// ---------------------------------------------------------------------------

test("syntax gate passes a valid ES module", () => {
  const d = tmp();
  const f = join(d, "ok.js");
  writeFileSync(f, "export const a = 1;\nexport function g() { return a; }\n");
  assert.deepEqual(checkFiles([f]), []);
});

test("syntax gate catches a genuine syntax error", () => {
  const d = tmp();
  const f = join(d, "broken.js");
  writeFileSync(f, "export function f( {\n  let x = ;\n}\n");
  const failures = checkFiles([f]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /SyntaxError/);
});

test("syntax gate catches binary corruption and reports the byte offset", () => {
  const d = tmp();
  const f = join(d, "corrupt.js");
  const head = Buffer.from("export const a = 1;\n".repeat(20), "utf8");
  // NUL and other control bytes spliced in, mimicking the playground.js fault.
  writeFileSync(f, Buffer.concat([head, Buffer.from([0x00, 0x0c, 0x1e, 0x00])]));
  const failures = checkFiles([f]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /binary data at byte offset/);
  assert.match(failures[0].reason, /git checkout --/);
});

test("syntax gate catches invalid UTF-8", () => {
  const d = tmp();
  const f = join(d, "badutf.js");
  // A lone 0xFF byte is not valid UTF-8 and decodes to U+FFFD.
  writeFileSync(f, Buffer.concat([Buffer.from("export const a = 1; // "), Buffer.from([0xff, 0xfe])]));
  const failures = checkFiles([f]);
  assert.equal(failures.length, 1);
});

test("syntax gate reports an unreadable file instead of throwing", () => {
  const failures = checkFiles([join(tmp(), "does-not-exist.js")]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /cannot read/);
});

// ---------------------------------------------------------------------------
// coverage gate
// ---------------------------------------------------------------------------

const LCOV = [
  "TN:",
  "SF:src/a.js",
  "LF:10",
  "LH:9",
  "BRF:4",
  "BRH:3",
  "FNF:2",
  "FNH:2",
  "end_of_record",
  "TN:",
  "SF:src/b.js",
  "LF:10",
  "LH:5",
  "BRF:4",
  "BRH:1",
  "FNF:2",
  "FNH:1",
  "end_of_record",
].join("\n");

test("parseLcov reads per-file line/branch/function coverage", () => {
  const cov = parseLcov(LCOV);
  assert.equal(Object.keys(cov).length, 2);
  assert.equal(cov["src/a.js"].lines, 90);
  assert.equal(cov["src/b.js"].lines, 50);
  assert.equal(cov["src/a.js"].branches, 75);
});

test("parseLcov sums repeated records for the same file", () => {
  // lcov repeats a file once per test file, so hits must accumulate.
  const repeated =
    "SF:src/a.js\nLF:10\nLH:5\nBRF:2\nBRH:1\nFNF:1\nFNH:1\nend_of_record\n" +
    "SF:src/a.js\nLF:10\nLH:5\nBRF:2\nBRH:1\nFNF:1\nFNH:1\nend_of_record\n";
  const cov = parseLcov(repeated);
  assert.equal(cov["src/a.js"].lines, 50);
  assert.equal(cov["src/a.js"].raw.lines[0], 20, "denominators accumulate");
});

test("evaluate passes when coverage clears the thresholds", () => {
  const high = {
    "src/serve.js": { lines: 99, branches: 99, functions: 99, raw: { lines: [10, 10], branches: [10, 10], functions: [10, 10] } },
    "src/mcp.js": { lines: 99, branches: 99, functions: 99, raw: { lines: [10, 10], branches: [10, 10], functions: [10, 10] } },
    "src/editor.js": { lines: 99, branches: 99, functions: 99, raw: { lines: [10, 10], branches: [10, 10], functions: [10, 10] } },
    "src/ai.js": { lines: 99, branches: 99, functions: 99, raw: { lines: [10, 10], branches: [10, 10], functions: [10, 10] } },
    "src/playground.js": { lines: 99, branches: 99, functions: 99, raw: { lines: [10, 10], branches: [10, 10], functions: [10, 10] } },
  };
  const r = evaluate(high);
  assert.deepEqual(r.failures, []);
});

test("evaluate fails when coverage drops below a threshold", () => {
  const low = {
    "src/serve.js": { lines: 10, branches: 10, functions: 10, raw: { lines: [10, 1], branches: [10, 1], functions: [10, 1] } },
  };
  const r = evaluate(low);
  assert.ok(r.failures.length > 0, "expected failures");
  assert.ok(r.failures.some((f) => f.scope === "GLOBAL"));
  assert.ok(r.failures.some((f) => f.scope === "src/serve.js"));
});

test("evaluate flags a critical file that no test even imports", () => {
  const r = evaluate({ "src/unrelated.js": { lines: 100, branches: 100, functions: 100, raw: { lines: [1, 1], branches: [1, 1], functions: [1, 1] } } });
  const missing = r.failures.filter((f) => f.missing);
  assert.ok(missing.length >= 4, `expected the critical files to be reported missing, got ${JSON.stringify(r.failures)}`);
});

test("the thresholds are self-consistent (floors within 0-100)", () => {
  for (const [metric, floor] of Object.entries(THRESHOLDS.global)) {
    assert.ok(floor > 0 && floor <= 100, `global ${metric} floor out of range: ${floor}`);
  }
  for (const [file, floors] of Object.entries(THRESHOLDS.critical)) {
    for (const [metric, floor] of Object.entries(floors)) {
      assert.ok(floor > 0 && floor <= 100, `${file} ${metric} floor out of range: ${floor}`);
    }
  }
});

// ---------------------------------------------------------------------------
// declaration drift check
// ---------------------------------------------------------------------------

test("declaredValueNames finds functions, consts and re-export lists", () => {
  const names = declaredValueNames(
    [
      "export function a(x: number): void;",
      "export const b: string;",
      "export class C {}",
      "export { d, e as f };",
      "export type T = 1;",
      "export interface I {}",
    ].join("\n")
  );
  assert.ok(names.has("a"));
  assert.ok(names.has("b"));
  assert.ok(names.has("C"));
  assert.ok(names.has("d"));
  assert.ok(names.has("f"));
  assert.ok(!names.has("T"), "type aliases are not runtime values");
  assert.ok(!names.has("I"), "interfaces are not runtime values");
});

test("declaredTypeNames finds type-only exports", () => {
  const names = declaredTypeNames("export type T = 1;\nexport interface I {}\nexport { type U };");
  assert.ok(names.has("T"));
  assert.ok(names.has("I"));
});

test("compare flags a runtime export that is not declared", () => {
  const { undeclared, phantom } = compare(["a", "b"], "export function a(): void;");
  assert.deepEqual(undeclared, ["b"]);
  assert.deepEqual(phantom, []);
});

test("compare flags a declaration with no runtime value", () => {
  const { undeclared, phantom } = compare(["a"], "export function a(): void;\nexport function ghost(): void;");
  assert.deepEqual(undeclared, []);
  assert.deepEqual(phantom, ["ghost"]);
});

test("compare is satisfied when declarations match the runtime", () => {
  const { undeclared, phantom } = compare(["a", "b"], "export function a(): void;\nexport const b = 1;");
  assert.deepEqual(undeclared, []);
  assert.deepEqual(phantom, []);
});

test("compare ignores names declared only as types", () => {
  // A type-only re-export has no runtime value and must not be flagged.
  const { undeclared } = compare(["a"], "export function a(): void;\nexport type Tok = any;");
  assert.deepEqual(undeclared, []);
});
