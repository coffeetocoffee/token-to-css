import { readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { deepMerge } from "./merge.js";
import { lintTokens, checkContract } from "./lint.js";
import { buildNameRegistry } from "./registry.js";
import { semverSatisfies, analyzeLockfile } from "./release.js";

function getByPathLocal(node, path) {
  let cur = node;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

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
 *
 * v11.0: a team entry may reference a *published token package* from another
 * org instead of a local path:
 *
 * ```json
 * {
 *   "name": "my-org",
 *   "packages": { "@acme/tokens": "./registry/acme-tokens" },
 *   "teams": {
 *     "core":  { "path": "./tokens.json", "priority": 0 },
 *     "acme":  { "org": "acme", "package": "@acme/tokens", "range": "^2.0" }
 *   }
 * }
 * ```
 *
 * A package team's directory holds one `<version>.json` release snapshot per
 * published version (as emitted by the v10 `release` flow); the newest
 * in-range version is picked. Remote package trees merge with the v7 priority
 * rules, so they lose to local teams unless given a higher priority.
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
    if (!config || typeof config !== "object") {
      throw new Error(`team "${name}" must be an object`);
    }
    if (config.package) {
      if (!config.org || typeof config.org !== "string") {
        throw new Error(`remote team "${name}" must have an 'org' field`);
      }
      if (typeof config.package !== "string") {
        throw new Error(`remote team "${name}" must have a string 'package' field`);
      }
      teams[name] = {
        org: config.org,
        package: config.package,
        range: config.range || "*",
        priority: config.priority ?? -1,
        overrides: config.overrides || [],
      };
      continue;
    }
    if (!config.path) throw new Error(`team "${name}" must have a 'path' field`);
    teams[name] = {
      path: resolvePath(baseDir, config.path),
      priority: config.priority ?? 0,
      overrides: config.overrides || [],
    };
  }

  const packages = {};
  if (manifest.packages && typeof manifest.packages === "object") {
    for (const [pkgName, dir] of Object.entries(manifest.packages)) {
      if (typeof dir !== "string") {
        throw new Error(`packages.${pkgName} must be a directory path`);
      }
      packages[pkgName] = resolvePath(baseDir, dir);
    }
  }

  return {
    name: manifest.name || "unnamed-org",
    version: manifest.version || "1.0.0",
    teams,
    packages,
    overrides: manifest.overrides || {},
  };
}

/**
 * List the published versions of a package release directory (v11.0).
 * Returns a semver-sorted ascending list of version strings.
 */
export function listPackageVersions(packagesDir, packageName) {
  const base = packageName
    ? resolvePath(packagesDir || ".", packageName)
    : resolvePath(packagesDir || ".");
  let files;
  try {
    files = readdirSync(base).filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error(`package not found: ${packageName || "(root)"} (${base})`);
  }
  const compare = (a, b) => {
    const [a1, a2, a3] = a.split(".").map(Number);
    const [b1, b2, b3] = b.split(".").map(Number);
    return a1 - b1 || a2 - b2 || a3 - b3;
  };
  return files.map((f) => f.replace(/\.json$/, "")).sort(compare);
}

/**
 * Resolve a published token package to the newest in-range release snapshot
 * (v11.0). `ref` is `{ package, range }` (or a plain package name).
 * Returns `{ name, version, tree, path }`.
 */
export function resolvePackage(ref, { packages = {}, registryDir = null } = {}) {
  const name = typeof ref === "string" ? ref : ref.package;
  if (!name) throw new Error("resolvePackage requires a package name");
  const range = typeof ref === "string" ? "*" : ref.range || "*";
  const dir = registryDir || packages[name] || null;
  if (!dir) {
    throw new Error(
      `package not resolvable: ${name} (add a "packages" map or pass registryDir)`
    );
  }
  const versions = listPackageVersions(dir, "").filter((v) =>
    semverSatisfies(v, range)
  );
  if (!versions.length) {
    throw new Error(`no version of ${name} satisfies range "${range}"`);
  }
  const version = versions[versions.length - 1];
  const path = resolvePath(dir, `${version}.json`);
  const tree = JSON.parse(readFileSync(path, "utf8"));
  return { name, version, tree, path };
}

/**
 * Resolve all team token trees into one merged org tree.
 * Teams are merged in priority order; higher priority overrides lower.
 * Remote (package) teams default to priority -1 so they lose to local teams.
 *
 * v11.0: the result also carries:
 *  - `origins`: `{ [dotted.path]: { org, team } }` — which team/org last
 *    supplied each merged token value (token provenance across orgs).
 *  - `resolvedPackages`: `{ [team]: { name, version } }` for package teams.
 */
export function resolveOrgTree(manifest) {
  const sorted = Object.entries(manifest.teams).sort(
    ([, a], [, b]) => a.priority - b.priority
  );

  let merged = {};
  const teamTrees = {};
  const resolvedPackages = {};

  for (const [name, config] of sorted) {
    let raw;
    if (config.package) {
      const pkg = resolvePackage(config, {
        packages: manifest.packages || {},
      });
      resolvedPackages[name] = { name: pkg.name, version: pkg.version };
      raw = pkg.tree;
    } else {
      raw = JSON.parse(readFileSync(config.path, "utf8"));
    }
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

  // Provenance: walk the merged tree's leaves; the highest-priority team that
  // contains the path is the org of origin of the merged value.
  const priorityOrder = sorted; // ascending priority; later assignments win
  const origins = {};
  (function walk(node, prefix) {
    for (const [key, value] of Object.entries(node)) {
      const p = [...prefix, key];
      const isLeaf =
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (typeof value === "object" && "$value" in value);
      if (isLeaf) {
        for (const [teamName] of priorityOrder) {
          if (getByPathLocal(teamTrees[teamName], p) !== undefined) {
            origins[p.join(".")] = {
              org: manifest.teams[teamName].org || manifest.name || null,
              team: teamName,
            };
          }
        }
      } else {
        walk(value, p);
      }
    }
  })(merged, []);

  return { merged, teamTrees, origins, resolvedPackages };
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
 * Merge per-org, per-team canonical name registries into one federated
 * registry (v11.0). Canonical names grow an org segment:
 * `org:team:canonical` — so two orgs that both have `color.primary` keep
 * distinct, losslessly round-trippable names.
 *
 * `orgRegistries` is `{ [org]: { [team]: registry } }` (a bare registry is
 * accepted as the only team, keyed `default`). The returned registry is
 * reverse-compatible: `canonicalOf(path)` works on plain token paths (the
 * org name may optionally be path[0]), and `pathOf(canonical)` returns the
 * token path array. `ownerOf(canonical)` returns `{ org, team }`.
 */
export function mergeOrgRegistries(orgRegistries) {
  const allEntries = [];
  const pathToCanonical = new Map();
  const canonicalToPath = new Map();
  const ownerOfCanonical = new Map();
  const orgNames = new Set(Object.keys(orgRegistries));

  for (const [org, teams] of Object.entries(orgRegistries)) {
    const teamRegistries =
      teams && typeof teams.toJSON === "function" ? { default: teams } : teams;
    for (const [team, registry] of Object.entries(teamRegistries)) {
      const json = registry.toJSON();
      for (const entry of json.names) {
        const innerPath = entry.path.split(".");
        const canonical = `${org}:${team}:${entry.canonical}`;
        const fullPath = [org, ...innerPath];
        const e = { org, team, path: fullPath, canonical };
        allEntries.push(e);
        pathToCanonical.set(`${org}\u0000${innerPath.join("\u0000")}`, canonical);
        canonicalToPath.set(canonical, fullPath);
        ownerOfCanonical.set(canonical, { org, team });
      }
    }
  }

  function lookup(org, innerPath, team = null) {
    if (team != null) {
      return pathToCanonical.get(`${org}\u0000${innerPath.join("\u0000")}`) || null;
    }
    for (const e of allEntries) {
      if (e.org === org && e.path.length === innerPath.length + 1) {
        const inner = e.path.slice(1);
        if (inner.every((seg, i) => seg === innerPath[i])) return e.canonical;
      }
    }
    return null;
  }

  return {
    entries: allEntries,
    orgs: orgNames,
    canonicalOf(orgOrPath, teamOrPath, maybePath) {
      if (Array.isArray(orgOrPath)) {
        const [first, ...rest] = orgOrPath;
        if (orgNames.has(first) && rest.length) {
          const hit = lookup(first, rest);
          if (hit) return hit;
        }
        // plain path: search every org/team (first match wins)
        const hit = pathToCanonical.get(`${orgOrPath.join("\u0000")}`);
        if (hit) return hit;
        for (const org of orgNames) {
          const h = lookup(org, orgOrPath);
          if (h) return h;
        }
        return null;
      }
      if (Array.isArray(teamOrPath)) {
        return lookup(orgOrPath, teamOrPath);
      }
      return lookup(orgOrPath, maybePath, teamOrPath);
    },
    pathOf(canonical) {
      return canonicalToPath.get(canonical) || null;
    },
    ownerOf(canonical) {
      return ownerOfCanonical.get(canonical) || null;
    },
    has(canonical) {
      return canonicalToPath.has(canonical);
    },
    toJSON() {
      return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        name: "token-to-css federated org registry",
        version: 2,
        names: allEntries.map((e) => ({
          org: e.org,
          team: e.team,
          path: e.path.join("."),
          canonical: e.canonical,
        })),
      };
    },
  };
}

/**
 * Parse and validate a *federated* (cross-org) manifest (v11.0):
 *
 * ```json
 * {
 *   "name": "alliance",
 *   "orgs": {
 *     "acme":   { "path": "./acme.manifest.json" },
 *     "globex": { "teams": { "core": { "path": "./globex/tokens.json" } } }
 *   }
 * }
 * ```
 *
 * Each org is an org manifest (v7 shape) inline or referenced by path.
 */
export function validateFederatedManifest(manifest, basePath = ".") {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("federated manifest must be a JSON object");
  }
  if (!manifest.orgs || typeof manifest.orgs !== "object") {
    throw new Error("federated manifest must have an 'orgs' object");
  }
  const baseDir = basePath.endsWith(".json") ? dirname(basePath) : basePath;
  const orgs = {};
  for (const [orgName, cfg] of Object.entries(manifest.orgs)) {
    let orgManifest;
    if (cfg && cfg.path) {
      orgManifest = buildOrgManifest(resolvePath(baseDir, cfg.path));
    } else if (cfg && cfg.teams) {
      orgManifest = validateManifest(cfg, basePath);
    } else {
      throw new Error(`org "${orgName}" must have 'teams' or 'path'`);
    }
    for (const team of Object.values(orgManifest.teams)) {
      if (!team.org) team.org = orgName;
    }
    orgs[orgName] = orgManifest;
  }
  return {
    name: manifest.name || "federation",
    version: manifest.version || "1.0.0",
    orgs,
  };
}

/** Parse and validate a federated manifest file. */
export function buildFederatedManifest(manifestPath) {
  const resolved = resolvePath(manifestPath);
  const raw = JSON.parse(readFileSync(resolved, "utf8"));
  return validateFederatedManifest(raw, resolved);
}

/**
 * Resolve every org in a federated manifest into merged trees (v11.0).
 * Orgs are merged in manifest key order (later org wins cross-org
 * collisions); within an org the v7 priority rules apply. Returns
 * `{ merged, orgTrees: { [org]: resolveOrgTree result }, origins }` where
 * `origins[path] = { org, team }` records which org introduced each token.
 */
export function resolveFederatedTree(fedManifest) {
  const orgTrees = {};
  const origins = {};
  let merged = {};
  for (const [org, manifest] of Object.entries(fedManifest.orgs)) {
    const r = resolveOrgTree(manifest);
    orgTrees[org] = r;
    for (const [path, o] of Object.entries(r.origins || {})) {
      origins[path] = { org, team: o.team };
    }
    // Clone: r.merged is orgTrees[org].merged by reference, and deep-merging
    // it directly would pollute that org's own merged tree.
    deepMerge(merged, structuredClone(r.merged));
  }
  return { merged, orgTrees, origins };
}

/**
 * Cross-org consumer lockfile check (v11.0).
 *
 * `lock` is the v10 lockfile shape plus a `package` field:
 * `{ name?, package, range, uses, version? }`. The previous release is the
 * newest version in the lock's range (or the exact `lock.version` when
 * pinned); the next release is `options.nextVersion` (exact) or the newest
 * published version overall. Reuses the v10 `analyzeLockfile` machinery, so
 * a consumer pinned `^2.x` fails a cross-org 3.0 release listing every
 * affected usage.
 */
export function analyzeCrossOrgLock(lock, registryDir, { nextVersion = null } = {}) {
  if (!lock || !lock.package) {
    throw new Error("cross-org lockfile requires a 'package' field");
  }
  let versionFiles;
  try {
    versionFiles = readdirSync(resolvePath(registryDir)).filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error(`no published versions found in ${registryDir}`);
  }
  const versions = versionFiles.map((version) => ({
    version: version.replace(/\.json$/, ""),
    path: resolvePath(registryDir, version),
  }));
  if (!versions.length) {
    throw new Error(`no published versions found in ${registryDir}`);
  }
  const inRange = versions.filter((v) =>
    semverSatisfies(v.version, lock.range || "*")
  );
  const prev =
    (lock.version && versions.find((v) => v.version === lock.version)) ||
    inRange[inRange.length - 1] ||
    versions[0];
  const next = nextVersion
    ? versions.find((v) => v.version === nextVersion)
    : versions[versions.length - 1];
  if (!next) {
    throw new Error(`version ${nextVersion} of ${lock.package} not found in ${registryDir}`);
  }
  const prevTokens = JSON.parse(readFileSync(prev.path, "utf8"));
  const nextTokens = JSON.parse(readFileSync(next.path, "utf8"));
  const result = analyzeLockfile(lock, prevTokens, nextTokens, next.version);
  return {
    package: lock.package,
    prevVersion: prev.version,
    nextVersion: next.version,
    ...result,
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
      const raw = config.package
        ? resolvePackage(config, { packages: manifest.packages || {} }).tree
        : JSON.parse(readFileSync(config.path, "utf8"));
      const lintResult = lintTokens(raw);
      const contractResult = contract ? checkContract(raw, contract) : null;
      results[name] = {
        path: config.path || config.package,
        lint: lintResult,
        contract: contractResult,
      };
    } catch (err) {
      results[name] = {
        path: config.path || config.package,
        error: err.message,
      };
    }
  }
  return results;
}
