import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { deepMerge } from "./merge.js";
import { lintTokens, checkContract } from "./lint.js";
import { buildNameRegistry } from "./registry.js";

/**
 * Parse and validate an org manifest file.
 */
export function buildOrgManifest(manifestPath) {
  const resolved = resolvePath(manifestPath);
  const raw = JSON.parse(readFileSync(resolved, "utf8"));
  return validateManifest(raw, resolved);
}

/**
 * Parse and validate an org manifest object (already parsed JSON).
 */
export function validateManifest(manifest, basePath = ".") {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("org manifest must be a JSON object");
  }
  if (!manifest.teams || typeof manifest.teams !== "object") {
    throw new Error("org manifest must have a 'teams' object");
  }

  const baseDir = basePath.endsWith(".json") ? dirname(basePath) : basePath;
  const teams = {};
  for (const [name, config] of Object.entries(manifest.teams)) {
    if (!config.path) throw new Error(`team "${name}" must have a 'path' field`);
    teams[name] = {
      path: resolvePath(baseDir, config.path),
      priority: config.priority ?? 0,
      overrides: config.overrides || [],
    };
  }

  return {
    name: manifest.name || "unnamed-org",
    version: manifest.version || "1.0.0",
    teams,
    overrides: manifest.overrides || {},
  };
}

/**
 * Resolve all team token trees into one merged org tree.
 * Teams are merged in priority order; higher priority overrides lower.
 */
export function resolveOrgTree(manifest) {
  const sorted = Object.entries(manifest.teams).sort(
    ([, a], [, b]) => a.priority - b.priority
  );

  let merged = {};
  const teamTrees = {};

  for (const [name, config] of sorted) {
    const raw = JSON.parse(readFileSync(config.path, "utf8"));
    teamTrees[name] = raw;

    const overrideConfig = manifest.overrides[name];
    if (overrideConfig && overrideConfig.extends) {
      const baseTeam = overrideConfig.extends;
      if (teamTrees[baseTeam]) {
        const base = structuredClone(teamTrees[baseTeam]);
        deepMerge(base, raw);
        teamTrees[name] = base;
      }
    }

    deepMerge(merged, teamTrees[name]);
  }

  return { merged, teamTrees };
}

/**
 * Merge multiple canonical name registries into one.
 * Each team's entries are prefixed with the team name to avoid cross-team collisions.
 */
export function mergeRegistries(registries) {
  const allEntries = [];
  const pathToCanonical = new Map();
  const canonicalToPath = new Map();

  for (const [teamName, registry] of Object.entries(registries)) {
    const json = registry.toJSON();
    for (const entry of json.names) {
      const prefixedCanonical = `${teamName}:${entry.canonical}`;
      const path = entry.path.split(".");
      allEntries.push({
        team: teamName,
        path,
        canonical: prefixedCanonical,
        originalCanonical: entry.canonical,
      });
      pathToCanonical.set(`${teamName}:${path.join("\u0000")}`, prefixedCanonical);
      canonicalToPath.set(prefixedCanonical, { team: teamName, path });
    }
  }

  return {
    entries: allEntries,
    canonicalOf(teamOrPath, maybePath) {
      if (Array.isArray(teamOrPath)) {
        for (const key of Object.keys(registries)) {
          const result = pathToCanonical.get(`${key}:${teamOrPath.join("\u0000")}`);
          if (result) return result;
        }
        return null;
      }
      return pathToCanonical.get(`${teamOrPath}:${maybePath.join("\u0000")}`) || null;
    },
    pathOf(canonical) {
      return canonicalToPath.get(canonical) || null;
    },
    toJSON() {
      return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        name: "token-to-css org registry",
        version: 1,
        names: allEntries.map((e) => ({
          team: e.team,
          path: e.path.join("."),
          canonical: e.canonical,
        })),
      };
    },
  };
}

/**
 * Run lintTokens and checkContract across every team's token set.
 * Returns a map of team name → lint results.
 */
export function lintOrg(manifest, contract = null) {
  const results = {};
  for (const [name, config] of Object.entries(manifest.teams)) {
    try {
      const raw = JSON.parse(readFileSync(config.path, "utf8"));
      const lintResult = lintTokens(raw);
      const contractResult = contract ? checkContract(raw, contract) : null;
      results[name] = {
        path: config.path,
        lint: lintResult,
        contract: contractResult,
      };
    } catch (err) {
      results[name] = {
        path: config.path,
        error: err.message,
      };
    }
  }
  return results;
}
