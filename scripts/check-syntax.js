#!/usr/bin/env node
/**
 * Syntax gate — fail fast on a file that does not parse.
 *
 * Why this exists: a single corrupted file (src/playground.js read back as
 * binary past byte 8192) took down ALL 363 tests at once, because both
 * src/index.js and src/cli.js import it. Nothing caught it until `npm test`
 * ran, which is the most expensive moment to find out and looks like a total
 * codebase failure rather than one bad byte range.
 *
 * This checks every shipped source file parses, and — crucially — reports the
 * FIRST BAD BYTE OFFSET, since a mid-file corruption is otherwise reported by
 * Node as an innocent-looking syntax error inside working code.
 *
 * Zero dependencies, same as the rest of the project. Run:
 *   node scripts/check-syntax.js          # all src/
 *   node scripts/check-syntax.js --staged # only git-staged files (hook use)
 *
 * Exits 1 on the first failure, listing every failing file.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK_DIRS = ["src", "packages/core/src", "packages/connectors/src", "scripts"];
const EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
// Whole-file directory trees to skip.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory may not exist in a partial checkout
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTENSIONS.has(extname(e.name))) out.push(p);
  }
  return out;
}

/** Control bytes that must never appear in a JS source file. */
function findControlBytes(buf) {
  const hits = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // Allow tab(9), LF(10), CR(13). Everything else below 0x20 is suspicious.
    if (b < 0x09 || (b > 0x0a && b < 0x0d) || (b > 0x0d && b < 0x20)) {
      hits.push(i);
      if (hits.length >= 5) break;
    }
  }
  return hits;
}

/** Does this file parse as an ES module? Returns null or an error message. */
function parseError(file) {
  // IMPORTANT: `node --check <file>.js` is NOT reliable here. Node decides
  // module-vs-script from the nearest package.json; with no `"type": "module"`
  // in scope it parses the file as a CommonJS SCRIPT, where `export` statements
  // are a syntax error that --check reports as exit 0 — i.e. it silently
  // passes genuinely broken ESM. (Hit this while building the gate.)
  // `--input-type=module` on stdin forces module parsing regardless of cwd.
  try {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {
      input: readFileSync(file),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null;
  } catch (err) {
    const stderr = (err.stderr || Buffer.from("")).toString("utf8");
    const lines = stderr.split("\n").filter(Boolean);
    // Prefer the parser message line; fall back to the first line.
    const msg = lines.find((l) => /Error|error/.test(l)) || lines[0] || "parse failed";
    return msg.trim();
  }
}

function stagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => EXTENSIONS.has(extname(f)))
    .filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg)))
    .map((f) => join(ROOT, f));
}

export function checkFiles(files) {
  const failures = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split("\\").join("/");
    let buf;
    try {
      buf = readFileSync(file);
    } catch (err) {
      failures.push({ file: rel, reason: `cannot read: ${err.message}` });
      continue;
    }

    // 1. Binary / control-byte scan — catches the corruption class directly
    //    and points at the offset, which a syntax error alone does not.
    const ctl = findControlBytes(buf);
    if (ctl.length) {
      failures.push({
        file: rel,
        reason:
          `binary data at byte offset ${ctl[0]} (${ctl.length}+ control bytes) — ` +
          `likely filesystem corruption, restore with: git checkout -- ${rel}`,
      });
      continue;
    }

    // 2. Extension / content sanity.
    const text = buf.toString("utf8");
    if (text.includes("\uFFFD")) {
      const at = text.indexOf("\uFFFD");
      failures.push({
        file: rel,
        reason: `invalid UTF-8 near character offset ${at} — file is not valid text`,
      });
      continue;
    }

    // 3. Parse it.
    const err = parseError(file);
    if (err) failures.push({ file: rel, reason: err });
  }
  return failures;
}

function main() {
  const staged = process.argv.includes("--staged");
  const files = staged ? stagedFiles() : CHECK_DIRS.flatMap((d) => walk(join(ROOT, d)));

  if (!files.length) {
    console.log(staged ? "check-syntax: no staged JS files" : "check-syntax: no files found");
    return 0;
  }

  const failures = checkFiles(files);
  if (failures.length) {
    console.error(`\ncheck-syntax: ${failures.length} file(s) FAILED\n`);
    for (const f of failures) console.error(`  ${f.file}\n    ${f.reason}\n`);
    return 1;
  }

  console.log(`check-syntax: OK (${files.length} file${files.length === 1 ? "" : "s"})`);
  return 0;
}

// Only run when executed directly, so the tests can import checkFiles().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
