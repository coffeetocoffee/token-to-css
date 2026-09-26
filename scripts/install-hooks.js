#!/usr/bin/env node
/**
 * Install the pre-commit hook (no husky — zero dependencies).
 *
 * Writing to .git/hooks is local-only and never committed, so this has to be run
 * once per clone: `npm run hooks:install`. CI enforces the same gates
 * independently, so a clone that skips this is still protected on push.
 */
import { writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HOOK = `#!/bin/sh
# Installed by scripts/install-hooks.js — rerun \`npm run hooks:install\` to update.
# Blocks a commit whose STAGED files do not parse. This is the cheap gate that
# would have caught the playground.js corruption at commit time instead of as
# 363 test failures.
exec node scripts/check-syntax.js --staged
`;

function gitDir() {
  try {
    return execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  const dir = gitDir();
  if (!dir) {
    console.error("hooks:install: not a git repository — nothing installed");
    return 1;
  }
  // `git rev-parse --git-dir` may be relative (".git") or absolute.
  const abs = dir.startsWith("/") || /^[A-Za-z]:/.test(dir) ? dir : join(ROOT, dir);
  const hooksDir = join(abs, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes("scripts/check-syntax.js") && !existing.includes("Installed by scripts/install-hooks.js")) {
      // Do not silently clobber someone's custom hook.
      console.error(
        `hooks:install: ${hookPath} already exists and was not created by us.\n` +
          "  Refusing to overwrite. Add this line manually to run the gate:\n" +
          "    node scripts/check-syntax.js --staged"
      );
      return 1;
    }
  }

  writeFileSync(hookPath, HOOK, "utf8");
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* Windows has no executable bit; the hook still runs via sh. */
  }
  console.log(`hooks:install: pre-commit hook installed at ${hookPath}`);
  return 0;
}

process.exit(main());
