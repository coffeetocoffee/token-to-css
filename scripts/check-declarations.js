#!/usr/bin/env node
/**
 * Declaration drift check — do the hand-maintained .d.ts files still describe
 * the real API?
 *
 * packages/core/index.d.ts is written by hand (97 exported values, mostly typed
 * `any`), so nothing forced it to track the implementation. It had already
 * drifted before this check existed: `deepMerge` and `mergeTokens` were real
 * runtime exports with no declaration at all, and adding `timingSafeTokenLookup`
 * made it three. A downstream TypeScript consumer would simply not see them.
 *
 * This compares each shipped .d.ts against the module it describes:
 *   - every runtime export must be DECLARED (else TS users cannot import it)
 *   - every declared value export must EXIST at runtime (else the types lie,
 *     and `import { x }` type-checks then fails at run time)
 *
 * It does not type-check the signatures — no TypeScript compiler, and adding one
 * would break the project's zero-dependency rule. It closes the "whole symbol
 * missing" class, which is the one that actually bit.
 *
 * Run: node scripts/check-declarations.js
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// package entry (declaration) -> module to import for the runtime truth
const PAIRS = [
  { dts: "packages/core/index.d.ts", module: "@token-to-css/core", label: "core" },
  { dts: "packages/connectors/index.d.ts", module: "@token-to-css/connectors", label: "connectors" },
];

/** Names of runtime VALUE exports declared by a .d.ts. Types are excluded. */
export function declaredValueNames(text) {
  const names = new Set();
  for (const m of text.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      const as = p.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/^export\s+default\b/m.test(text)) names.add("default");
  return names;
}

/** Names of declared TYPE-ONLY exports (interfaces, type aliases). */
export function declaredTypeNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (p.startsWith("type ")) names.add(p.slice(5).trim().split(/\s+as\s+/).pop());
    }
  }
  return names;
}

export function compare(runtimeNames, dtsText) {
  const runtime = new Set(runtimeNames.filter((n) => n !== "default"));
  const declaredValues = declaredValueNames(dtsText);
  const declaredTypes = declaredTypeNames(dtsText);

  // Undeclared runtime exports (excluding names declared as types only —
  // re-exported types have no runtime value and must not be flagged).
  const undeclared = [...runtime].filter(
    (n) => !declaredValues.has(n) && !declaredTypes.has(n)
  );

  // Declared as a value but absent at runtime — the types are lying.
  const phantom = [...declaredValues].filter((n) => !runtime.has(n));

  return { undeclared: undeclared.sort(), phantom: phantom.sort() };
}

async function main() {
  const problems = [];
  let checked = 0;

  for (const pair of PAIRS) {
    const dtsPath = join(ROOT, pair.dts);
    let dtsText;
    try {
      dtsText = readFileSync(dtsPath, "utf8");
    } catch {
      console.log(`check-declarations: ${pair.dts} not found, skipping`);
      continue;
    }

    let runtimeNames;
    try {
      const mod = await import(pair.module);
      runtimeNames = Object.keys(mod);
    } catch (err) {
      problems.push({
        file: pair.dts,
        reason: `cannot import ${pair.module} to compare: ${err.message}`,
      });
      continue;
    }

    checked++;
    const { undeclared, phantom } = compare(runtimeNames, dtsText);
    if (undeclared.length) {
      problems.push({
        file: pair.dts,
        reason: `${undeclared.length} runtime export(s) not declared: ${undeclared.join(", ")}`,
      });
    }
    if (phantom.length) {
      problems.push({
        file: pair.dts,
        reason: `${phantom.length} declared export(s) missing at runtime: ${phantom.join(", ")}`,
      });
    }
  }

  if (problems.length) {
    console.error(`\ncheck-declarations: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  ${p.file}\n    ${p.reason}\n`);
    return 1;
  }

  console.log(`check-declarations: OK (${checked} declaration file${checked === 1 ? "" : "s"} in sync)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
