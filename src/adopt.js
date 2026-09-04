import { readFileSync, writeFileSync } from "node:fs";
import { resolveReferences, normalizeW3C } from "./index.js";
import { parseColor, rgbToOklch, oklchDistance } from "./color.js";

function kebab(str) {
  return String(str)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/**
 * Build a CSS variable name for a token path. With a registry the canonical name
 * is used (lossless for kebab-colliding token names); otherwise the kebab path.
 */
function varNameFor(path, registry) {
  const name = registry ? registry.canonicalOf(path) : path.map(kebab).join("-");
  return `--${name}`;
}

function flattenResolved(tree, prefix = []) {
  const out = {};
  for (const [key, value] of Object.entries(tree)) {
    const p = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenResolved(value, p));
    } else if (value !== null && value !== undefined) {
      out[p.join(".")] = { path: p, value: String(value) };
    }
  }
  return out;
}

const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgba?|hsla?)\s*\([^)]*\)/g;
const DIM_RE = /\b\d*\.?\d+(?:px|rem|em|%|pt|vh|vw|ch|ex|fr|vmin|vmax)\b/g;
const VAR_RE = /var\(\s*(--[\w-]+)\s*\)/g;

/**
 * Build a searchable index of token values for consumer-code matching.
 * Returns `{ colorIndex, valueIndex }` where:
 *  - colorIndex: token color leaves with their parsed rgb + oklch + variable name
 *  - valueIndex: Map from normalized non-color value string -> variable name
 */
export function buildValueIndex(tokens, options = {}) {
  const tree = resolveReferences(normalizeW3C(tokens), { reduce: true });
  const flat = flattenResolved(tree);
  const registry = options.registry || null;
  const colorIndex = [];
  const valueIndex = new Map();

  for (const entry of Object.values(flat)) {
    const variable = varNameFor(entry.path, registry);
    const parsed = parseColor(entry.value);
    if (parsed) {
      colorIndex.push({
        variable,
        value: entry.value,
        rgb: parsed,
        oklch: rgbToOklch(parsed),
        path: entry.path.join("."),
      });
    } else {
      const norm = entry.value.trim().toLowerCase();
      if (!valueIndex.has(norm)) valueIndex.set(norm, variable);
    }
  }
  return { colorIndex, valueIndex };
}

function isExcludedContext(text, index) {
  // Skip matches inside var(--x) (already adopted).
  const before = text.slice(Math.max(0, index - 6), index);
  if (before.includes("var(")) return true;
  // Skip matches inside url(...) (e.g. url(#foo) isn't a color literal).
  const urlStart = text.lastIndexOf("url(", index);
  if (urlStart !== -1) {
    const seg = text.slice(urlStart, index);
    if (seg.includes("(") && !seg.includes(")")) return true;
  }
  // Skip the value of a CSS custom-property *declaration* (`--x: <value>`),
  // because those are token definitions, not consumer usages. Look at the
  // property immediately preceding this literal, not the first colon on the line.
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const seg = text.slice(lineStart, index);
  const declMatch = /([\w-]+)\s*:\s*$/.exec(seg);
  if (declMatch && declMatch[1].startsWith("--")) return true;
  return false;
}

/**
 * Find every hardcoded literal in a source text, with position + kind.
 * Returns `{ literals: [{value, index, kind, line, column}], adopted: number }`.
 */
export function scanSource(text) {
  const literals = [];
  const adopt = new Set();
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text))) adopt.add(m[1]);
  const push = (re, kind) => {
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(text))) {
      const value = mm[0];
      const index = mm.index;
      if (isExcludedContext(text, index)) continue;
      const line = text.slice(0, index).split("\n").length;
      const col = index - text.lastIndexOf("\n", index - 1);
      literals.push({ value, index, kind, line, column: col });
    }
  };
  push(COLOR_RE, "color");
  push(DIM_RE, "dimension");
  return { literals, adopted: adopt.size };
}

/**
 * Lint consumer source code against a token set. Reports hardcoded values that
 * match (exactly or, via OKLCH nearest-distance, nearly) a known token,
 * suggesting the `var(--token)` to use instead.
 *
 * `sources` is an array of `{ file, text }`. Returns:
 *   { findings, errors, warnings, summary }
 * where each finding is
 *   { file, line, column, value, kind, variable?, path?, exact, distance? }.
 */
export function lintConsumer(tokens, sources, options = {}) {
  const index = buildValueIndex(tokens, options);
  const maxDistance = options.maxDistance != null ? options.maxDistance : 0.1;
  const findings = [];

  for (const { file, text } of sources) {
    const { literals } = scanSource(text);
    for (const lit of literals) {
      if (lit.kind === "color") {
        const parsed = parseColor(lit.value);
        if (!parsed) continue;
        const oklch = rgbToOklch(parsed);
        let best = null;
        let bestDist = Infinity;
        for (const entry of index.colorIndex) {
          const d = oklchDistance(oklch, entry.oklch);
          if (d < bestDist) {
            bestDist = d;
            best = entry;
          }
        }
        if (best && bestDist < 1e-6) {
          findings.push({
            file,
            index: lit.index,
            line: lit.line,
            column: lit.column,
            value: lit.value,
            kind: "color",
            variable: best.variable,
            path: best.path,
            exact: true,
            distance: bestDist,
          });
        } else if (best && bestDist <= maxDistance) {
          findings.push({
            file,
            index: lit.index,
            line: lit.line,
            column: lit.column,
            value: lit.value,
            kind: "color",
            variable: best.variable,
            path: best.path,
            exact: false,
            distance: bestDist,
          });
        }
      } else {
        const norm = lit.value.trim().toLowerCase();
        const variable = index.valueIndex.get(norm);
        if (variable) {
          findings.push({
            file,
            index: lit.index,
            line: lit.line,
            column: lit.column,
            value: lit.value,
            kind: "dimension",
            variable,
            path: null,
            exact: true,
            distance: 0,
          });
        }
      }
    }
  }

  const errors = findings.length;
  const warnings = 0;
  return {
    findings,
    errors,
    warnings,
    summary: {
      total: findings.length,
      exact: findings.filter((f) => f.exact).length,
      nearest: findings.filter((f) => !f.exact).length,
    },
  };
}

/**
 * Apply the adoption codemod: rewrite each matched hardcoded literal to its
 * suggested `var(--token)`. Idempotent by construction — after rewriting, the
 * literal sits inside `var(...)` and `scanSource` skips it on the next run.
 *
 * Returns `{ results: [{file, changes, text}], totalChanges }`. When `dryRun` is
 * true the returned `text` reflects the rewrite but the caller should not write.
 */
export function applyConsumerCodemod(tokens, sources, options = {}) {
  const lint = lintConsumer(tokens, sources, options);
  const matchedByFile = new Map();
  for (const f of lint.findings) {
    if (!f.variable) continue;
    if (!matchedByFile.has(f.file)) matchedByFile.set(f.file, []);
    matchedByFile.get(f.file).push(f);
  }

  const results = [];
  let total = 0;
  for (const { file, text } of sources) {
    const found = matchedByFile.get(file) || [];
    if (found.length === 0) {
      results.push({ file, changes: 0, text });
      continue;
    }
    // Replace from the end so earlier indices stay valid.
    const sorted = [...found].sort((a, b) => b.index - a.index);
    let out = text;
    for (const f of sorted) {
      const replacement = `var(${f.variable})`;
      out = out.slice(0, f.index) + replacement + out.slice(f.index + f.value.length);
    }
    results.push({ file, changes: found.length, text: out });
    total += found.length;
  }
  return { results, totalChanges: total };
}

/**
 * Compute an adoption score for a set of consumer sources.
 * score = adoptedUsages / (adoptedUsages + hardcodedMatches) * 100.
 * `adoptedUsages` counts existing `var(--token)` references; `hardcodedMatches`
 * counts literals that *could* be a token but are hardcoded.
 */
export function computeAdoptionScore(tokens, sources, options = {}) {
  const lint = lintConsumer(tokens, sources, options);
  let adopted = 0;
  for (const { text } of sources) {
    VAR_RE.lastIndex = 0;
    const m = text.match(VAR_RE);
    if (m) adopted += m.length;
  }
  const hardcoded = lint.findings.length;
  const total = adopted + hardcoded;
  const score = total === 0 ? 100 : Math.round((adopted / total) * 100);
  return { score, adopted, hardcoded, total };
}

/**
 * Store a score snapshot (append to a JSON array file) and return all snapshots.
 */
export function storeSnapshot(path, info) {
  let all = [];
  try {
    all = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    all = [];
  }
  all.push({ date: new Date().toISOString(), ...info });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  return all;
}

/** Load score snapshots from a JSON array file. */
export function loadSnapshots(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Roll up a per-team adoption score across an org manifest. `sourcesByTeam` maps
 * a team name to its consumer source array (`{ file, text }[]`). Returns
 * `{ teams: { [team]: scoreInfo }, org: combinedScore }`.
 */
export function computeOrgAdoption(manifest, resolveOrgTreeFn, sourcesByTeam) {
  const { teamTrees } = resolveOrgTreeFn(manifest);
  const teams = {};
  for (const [team, sources] of Object.entries(sourcesByTeam)) {
    const tree = teamTrees[team] || {};
    teams[team] = computeAdoptionScore(tree, sources);
  }
  let adopted = 0;
  let hardcoded = 0;
  for (const info of Object.values(teams)) {
    adopted += info.adopted;
    hardcoded += info.hardcoded;
  }
  const total = adopted + hardcoded;
  const org = {
    score: total === 0 ? 100 : Math.round((adopted / total) * 100),
    adopted,
    hardcoded,
    total,
  };
  return { teams, org };
}
