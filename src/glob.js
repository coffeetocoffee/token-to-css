import { readdirSync } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";

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

function walk(dir, cwd, re, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, cwd, re, out);
    } else if (e.isFile()) {
      const abs = resolve(cwd, full).split("\\").join("/");
      if (re.test(abs)) out.push(full);
    }
  }
}

export function expandGlob(pattern, cwd = process.cwd()) {
  const absPattern = resolve(cwd, pattern).split("\\").join("/");
  const re = globToRegExp(absPattern);
  const m = absPattern.search(META);
  const base = m > -1 ? absPattern.slice(0, m) : absPattern;
  let baseDir = base.includes("/") ? base.replace(/\/[^\/]*$/, "") : ".";
  if (baseDir === "") baseDir = ".";
  const out = [];
  walk(resolve(cwd, baseDir), cwd, re, out);
  return out;
}

export function globBaseDir(pattern, cwd = process.cwd()) {
  const absPattern = resolve(cwd, pattern).split("\\").join("/");
  const m = absPattern.search(META);
  const base = m > -1 ? absPattern.slice(0, m) : absPattern;
  let baseDir = base.includes("/") ? base.replace(/\/[^\/]*$/, "") : ".";
  if (baseDir === "") baseDir = ".";
  return resolve(cwd, baseDir);
}

/**
 * Group already-expanded glob matches by their directory, relative to the
 * pattern's base directory.  Used by `--deep`: each directory group becomes a
 * namespace in the merged token tree (e.g. tokens/brand-a/*.json and
 * tokens/brand-b/*.json produce `brand-a.*` and `brand-b.*` keys) instead of
 * every file being flattened into the root where names collide.
 *
 * Returns an array of group descriptors, each:
 *   { dir: "brand-a" or ".", segments: ["brand-a"] or [], files: [absPath] }
 */
export function groupGlobByDir(pattern, cwd = process.cwd()) {
  const base = globBaseDir(pattern, cwd);
  const files = expandGlob(pattern, cwd);
  const map = new Map();
  for (const f of files) {
    const abs = resolve(cwd, f);
    const dir = dirname(abs);
    // Normalise to forward-slashes for cross-platform consistency
    const rel = relative(base, dir).split(sep).join("/");
    const key = rel === "" ? "." : rel;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return [...map.keys()]
    .sort()
    .map((dir) => ({
      dir,
      segments: dir === "." ? [] : dir.split("/"),
      files: map.get(dir).slice().sort(),
    }));
}

/**
 * Render a directory-group tree as human-readable text (indented tree lines).
 * Returns an array of lines — join with "\n" to print.
 */
export function renderDeepTree(groups) {
  const lines = [];
  for (const { dir, segments, files } of groups) {
    if (dir === ".") {
      for (const f of files) lines.push(f.split("\\").join("/"));
    } else {
      const indent = segments.map(() => "  ").join("");
      const header = segments.join("/") + "/";
      lines.push(indent + header);
      for (const f of files) {
        const name = f.split("\\").join("/").split("/").pop();
        lines.push(indent + "  " + name);
      }
    }
  }
  return lines;
}
