/**
 * Multi-root + glob config resolution (v12.3) — pure and vscode-free.
 *
 * `tokenToCss.tokensPath` may be a single path or a glob (e.g.
 * `packages/<star>/tokens.json`); every workspace folder is resolved and every
 * match gets its own language server. Zero-dep: directory walks use
 * `readdirSync`, glob matching is a tiny character-scanner compiled to a
 * RegExp — the same shape as the repo's core `glob.js` (which is not
 * imported: the extension is a thin client that never bundles the compiler).
 */
import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const META = /[*?{[]/;

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp("^" + re + "$");
}

function walk(dir, re, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, re, out, depth + 1);
    } else if (e.isFile()) {
      if (re.test(full.split(sep).join("/"))) out.push(full);
    }
  }
}

/** True when the pattern contains glob metacharacters. */
export function isGlobPattern(pattern) {
  return META.test(String(pattern || ""));
}

/**
 * Resolve the configured `tokensPath` against every workspace folder.
 * Returns an array of absolute token-file paths (sorted, de-duplicated).
 * Non-glob patterns that exist on disk pass straight through; a non-matching
 * non-glob still yields its literal path (the boot attempt reports the miss).
 */
export function resolveTokensPaths(root, pattern) {
  const roots = Array.isArray(root) ? root : [root];
  const out = [];
  const seen = new Set();
  for (const r of roots.filter(Boolean)) {
    const base = isAbsolute(pattern) ? pattern : join(r, pattern);
    const abs = resolve(base).split(sep).join("/");
    if (!isGlobPattern(pattern)) {
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
      continue;
    }
    const re = globToRegExp(abs);
    const m = abs.search(META);
    let baseDir = abs.slice(0, m);
    baseDir = baseDir.includes("/") ? baseDir.replace(/\/[^/]*$/, "") : ".";
    if (baseDir === "") baseDir = "/";
    const files = [];
    walk(baseDir, re, files);
    for (const f of files.sort()) {
      const norm = f.split(sep).join("/");
      if (!seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    }
  }
  return out;
}
