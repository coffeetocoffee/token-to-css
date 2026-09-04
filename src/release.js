import { diffTokens, resolveReferences, normalizeW3C } from "./index.js";

function kebab(str) {
  return String(str)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function getVal(tree, path) {
  let c = tree;
  for (const p of path) {
    if (c == null) return undefined;
    c = c[p];
  }
  return c;
}

/**
 * Compute the next semantic version given a base version and a bump kind.
 */
export function bumpVersion(version, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "0.0.0");
  let [maj, min, pat] = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  if (bump === "major") {
    maj += 1;
    min = 0;
    pat = 0;
  } else if (bump === "minor") {
    min += 1;
    pat = 0;
  } else if (bump === "patch") {
    pat += 1;
  }
  return `${maj}.${min}.${pat}`;
}

/**
 * Classify a token-set diff into a semantic-release bump:
 *   removed token -> major, changed value -> minor, added token -> patch.
 * Returns `{ bump, removed, changed, added }` (each a list of kebab token names).
 */
export function classifyRelease(prevTokens, nextTokens) {
  const d = diffTokens(prevTokens, nextTokens);
  const removed = Object.keys(d.removed);
  const changed = Object.keys(d.changed);
  const added = Object.keys(d.added);
  let bump = "none";
  if (removed.length) bump = "major";
  else if (changed.length) bump = "minor";
  else if (added.length) bump = "patch";
  return { bump, removed, changed, added };
}

/**
 * Render a changelog section for a version from a classifyRelease result.
 */
export function generateChangelog(version, result, { prevVersion } = {}) {
  const lines = [];
  lines.push(`## ${version}${prevVersion ? ` — ${prevVersion} → ${version}` : ""}`);
  lines.push("");
  if (result.added.length) {
    lines.push("### Added");
    for (const k of result.added) lines.push(`- \`${k}\``);
    lines.push("");
  }
  if (result.changed.length) {
    lines.push("### Changed");
    for (const k of result.changed) lines.push(`- \`${k}\``);
    lines.push("");
  }
  if (result.removed.length) {
    lines.push("### Removed (BREAKING)");
    for (const k of result.removed) lines.push(`- \`${k}\` (removed)`);
    lines.push("");
  }
  if (!result.added.length && !result.changed.length && !result.removed.length) {
    lines.push("_No changes._");
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

/**
 * End-to-end release classification: bump + next version + changelog.
 */
export function release(prevTokens, nextTokens, { version } = {}) {
  const result = classifyRelease(prevTokens, nextTokens);
  const nextVersion = bumpVersion(version || "0.0.0", result.bump);
  const changelog = generateChangelog(nextVersion, result, { prevVersion: version });
  return { bump: result.bump, nextVersion, changelog, ...result };
}

// --- Consumer lockfiles + breaking-change alerts ---

function parseV(v) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || "0").trim());
  if (!m) return [0, 0, 0];
  return [+m[1] || 0, +m[2] || 0, +m[3] || 0];
}

function wildcardSeg(s) {
  return s === "x" || s === "X" || s === "*" || s === "" || s == null;
}

/**
 * Minimal semver range check supporting exact, ^, ~, >=, >, <=, <, and "*".
 * "x"/"*" segments are treated as wildcards.
 */
export function semverSatisfies(version, range) {
  if (!range || range === "*" || range === "latest") return true;
  range = range.trim();
  const [maj, min, pat] = parseV(version);
  const cmp = (r) => {
    const [r1, r2, r3] = parseV(r);
    return maj > r1 || (maj === r1 && min > r2) || (maj === r1 && min === r2 && pat > r3);
  };
  const cmpEq = (r) => {
    const [r1, r2, r3] = parseV(r);
    return maj === r1 && min === r2 && pat === r3;
  };
  const cmpGe = (r) => cmp(r) || cmpEq(r);
  if (range.startsWith(">=")) return cmpGe(range.slice(2));
  if (range.startsWith("<=")) {
    const [r1, r2, r3] = parseV(range.slice(2));
    return maj < r1 || (maj === r1 && min < r2) || (maj === r1 && min === r2 && pat <= r3);
  }
  if (range.startsWith(">")) return cmp(range.slice(1));
  if (range.startsWith("<")) {
    const [r1, r2, r3] = parseV(range.slice(1));
    return maj < r1 || (maj === r1 && min < r2) || (maj === r1 && min === r2 && pat < r3);
  }
  if (range.startsWith("^") || range.startsWith("~")) {
    const caret = range.startsWith("^");
    const segs = range.slice(1).split(".");
    const [r1, r2] = parseV(range.slice(1));
    if (caret) {
      if (wildcardSeg(segs[0])) return true;
      if (maj !== r1) return false;
      if (wildcardSeg(segs[1])) return true;
      return min >= r2;
    }
    // tilde: maj must equal, min must equal (patch wildcard)
    if (wildcardSeg(segs[0])) return true;
    if (maj !== r1) return false;
    if (wildcardSeg(segs[1])) return true;
    return min === r2;
  }
  // exact (allow trailing .x)
  const segs = range.split(".");
  if (wildcardSeg(segs[0]) || wildcardSeg(segs[1]) || wildcardSeg(segs[2])) {
    const [r1, r2, r3] = parseV(range);
    if (!wildcardSeg(segs[0]) && maj !== r1) return false;
    if (!wildcardSeg(segs[1]) && min !== r2) return false;
    if (!wildcardSeg(segs[2]) && pat !== r3) return false;
    return true;
  }
  return cmpEq(range);
}

/**
 * Analyze a consumer lockfile against a target release.
 *
 * `lock` is `{ name, range, uses: ["color.primary", ...] }` where `uses` lists
 * the dotted token paths the consumer references (e.g. `var(--color-primary)`).
 * `prevTokens`/`nextTokens` are the pinned and target token sets; `nextVersion`
 * is the target release version string.
 *
 * Returns `{ inRange, ok, breaking }` where `breaking` is every used token that
 * was removed or changed between prev and next.
 */
export function analyzeLockfile(lock, prevTokens, nextTokens, nextVersion) {
  const d = diffTokens(prevTokens, nextTokens);
  const uses = (lock.uses || []).map((u) => u.split(".").map(kebab).join("-"));
  const breaking = [];
  for (const u of uses) {
    if (u in d.removed) {
      breaking.push({ path: u, type: "removed" });
    } else if (u in d.changed) {
      breaking.push({ path: u, type: "changed", from: d.changed[u].from, to: d.changed[u].to });
    }
  }
  const inRange = nextVersion ? semverSatisfies(nextVersion, lock.range) : true;
  const removedAffected = breaking.some((b) => b.type === "removed");
  const ok = inRange && !removedAffected;
  return { inRange, ok, breaking, range: lock.range, version: nextVersion };
}

// --- Time travel / bisect over checkpoints ---

/**
 * Walk an ordered list of checkpoints (`[{ id, label?, tree }]`) and find the
 * single checkpoint that first changed `tokenPath`'s resolved value.
 * Returns `{ found, index, id, from, to, prevId }` or `{ found: false }`.
 */
export function bisectToken(checkpoints, tokenPath) {
  const path = tokenPath.split(".");
  const values = checkpoints.map((cp) => {
    const tree = resolveReferences(normalizeW3C(cp.tree), { reduce: true });
    return { id: cp.id, label: cp.label, value: getVal(tree, path) };
  });
  for (let i = 1; i < values.length; i++) {
    if (values[i].value !== values[i - 1].value) {
      return {
        found: true,
        index: i,
        id: values[i].id,
        label: values[i].label,
        from: values[i - 1].value,
        to: values[i].value,
        prevId: values[i - 1].id,
        prevValue: values[i - 1].value,
      };
    }
  }
  return { found: false };
}

/** Render two token values side by side for a bisect report. */
export function renderSideBySide(tokenPath, from, to) {
  return [
    tokenPath,
    `  before: ${from === undefined ? "<absent>" : from}`,
    `  after:  ${to === undefined ? "<absent>" : to}`,
  ].join("\n");
}
