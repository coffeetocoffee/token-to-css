import { readdirSync } from "node:fs";
import { resolve, join } from "node:path";

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
