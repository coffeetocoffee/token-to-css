#!/usr/bin/env node
/**
 * Coverage gate — enforce a floor so "N tests passing" is not the only signal.
 *
 * The project quoted "363 tests passing" in commit messages but had no coverage
 * threshold, no lint gate, and no check that the hand-maintained .d.ts files
 * still match the implementation. Test COUNT says nothing about what is
 * exercised: cli.js could lose half its branches and the number would not move.
 *
 * Uses Node's built-in coverage (--experimental-test-coverage --test-reporter=lcov).
 * Zero dependencies, consistent with the rest of the project.
 *
 * Thresholds are set just BELOW the current measured values so the gate is
 * meaningful today and fails on a real regression, rather than being aspirational
 * and immediately red. Raise them as coverage improves.
 *
 * Run:  node scripts/check-coverage.js [--update]
 *       (--update rewrites the thresholds block below to today's numbers)
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- thresholds --------------------------------------------------------------
// Floor per metric, in percent. Set a little below the measured values so the
// gate fires on a real regression rather than on normal churn:
//   measured 2026-09-25: lines 83.5, branches 78.0, functions 84.7
// Raise these deliberately as coverage improves.
export const THRESHOLDS = {
  // Global floor across every instrumented file.
  global: { lines: 81, branches: 74, functions: 82 },
  // Files whose loss would be most damaging, so they must not slide.
  critical: {
    "src/serve.js": { lines: 78, branches: 78, functions: 74 },
    "src/mcp.js": { lines: 92, branches: 70, functions: 92 },
    "src/editor.js": { lines: 90, branches: 85, functions: 90 },
    "src/ai.js": { lines: 90, branches: 70, functions: 90 },
    "src/playground.js": { lines: 78, branches: 68, functions: 68 },
  },
};

/** Run the suite once with lcov coverage and return the raw lcov text. */
function runCoverage() {
  try {
    return execFileSync(
      process.execPath,
      ["--test", "--experimental-test-coverage", "--test-reporter=lcov"],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (err) {
    // A non-zero exit usually means tests failed; coverage is then moot.
    const stderr = (err.stderr || "").toString();
    if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-12).join("\n"));
    throw new Error("coverage run failed (tests probably failed — run `npm test` first)");
  }
}

/**
 * Parse lcov into per-file records.
 * lcov repeats records per test file, so totals are summed across records
 * rather than taken from any single block.
 */
export function parseLcov(text) {
  const files = new Map();
  let cur = null;
  const bump = (file, key, hit) => {
    const rec = files.get(file) || {
      lines: [0, 0],
      branches: [0, 0],
      functions: [0, 0],
    };
    rec[key][0] += hit[0];
    rec[key][1] += hit[1];
    files.set(file, rec);
  };

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("SF:")) {
      cur = t.slice(3).split("\\").join("/");
    } else if (t.startsWith("LF:")) {
      bump(cur, "lines", [+t.slice(3), 0]);
    } else if (t.startsWith("LH:")) {
      bump(cur, "lines", [0, +t.slice(3)]);
    } else if (t.startsWith("BRF:")) {
      bump(cur, "branches", [+t.slice(4), 0]);
    } else if (t.startsWith("BRH:")) {
      bump(cur, "branches", [0, +t.slice(4)]);
    } else if (t.startsWith("FNF:")) {
      bump(cur, "functions", [+t.slice(4), 0]);
    } else if (t.startsWith("FNH:")) {
      bump(cur, "functions", [0, +t.slice(4)]);
    }
  }

  const pct = ([found, hit]) => (found ? (hit / found) * 100 : 100);
  const out = {};
  for (const [file, rec] of files) {
    out[file] = {
      lines: pct(rec.lines),
      branches: pct(rec.branches),
      functions: pct(rec.functions),
      raw: rec,
    };
  }
  return out;
}

export function evaluate(coverage, thresholds = THRESHOLDS) {
  const failures = [];
  const rows = [];

  // Global totals.
  const total = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const rec of Object.values(coverage)) {
    for (const k of ["lines", "branches", "functions"]) {
      total[k][0] += rec.raw[k][0];
      total[k][1] += rec.raw[k][1];
    }
  }
  const gpct = (k) => (total[k][0] ? (total[k][1] / total[k][0]) * 100 : 100);
  const globalNow = {
    lines: gpct("lines"),
    branches: gpct("branches"),
    functions: gpct("functions"),
  };
  for (const [metric, floor] of Object.entries(thresholds.global)) {
    const got = globalNow[metric];
    rows.push({ scope: "GLOBAL", metric, got, floor });
    if (got < floor) failures.push({ scope: "GLOBAL", metric, got, floor });
  }

  // Critical files.
  const byShort = {};
  for (const [file, rec] of Object.entries(coverage)) {
    byShort[file] = rec;
    byShort[file.replace(/^\.\//, "")] = rec;
  }
  for (const [file, floors] of Object.entries(thresholds.critical)) {
    const rec = byShort[file] || byShort["./" + file] || byShort[file.replace(/^src\//, "src/")];
    if (!rec) {
      // File not instrumented (e.g. never imported by tests) — that is itself
      // worth knowing, so report it rather than silently skipping.
      failures.push({ scope: file, metric: "instrumented", got: 0, floor: 1, missing: true });
      continue;
    }
    for (const [metric, floor] of Object.entries(floors)) {
      const got = rec[metric];
      rows.push({ scope: file, metric, got, floor });
      if (got < floor) failures.push({ scope: file, metric, got, floor });
    }
  }
  return { failures, rows, globalNow };
}

function main() {
  // Coverage is expensive; allow opting out in constrained environments.
  if (process.env.SKIP_COVERAGE) {
    console.log("check-coverage: skipped (SKIP_COVERAGE set)");
    return 0;
  }

  let lcov;
  try {
    lcov = runCoverage();
  } catch (err) {
    console.error(`check-coverage: ${err.message}`);
    return 1;
  }

  const coverage = parseLcov(lcov);
  const fileCount = Object.keys(coverage).length;
  if (!fileCount) {
    console.error("check-coverage: no coverage data produced");
    return 1;
  }

  const { failures, rows, globalNow } = evaluate(coverage);
  console.log(
    `check-coverage: ${fileCount} files — ` +
      `lines ${globalNow.lines.toFixed(2)}%  branches ${globalNow.branches.toFixed(2)}%  ` +
      `functions ${globalNow.functions.toFixed(2)}%`
  );

  if (failures.length) {
    console.error(`\ncheck-coverage: ${failures.length} threshold(s) FAILED\n`);
    for (const f of failures) {
      const label = f.missing ? "not instrumented by any test" : `${f.got.toFixed(2)}% < ${f.floor}%`;
      console.error(`  ${f.scope}  ${f.metric}: ${label}`);
    }
    return 1;
  }

  console.log("check-coverage: all thresholds met");
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
