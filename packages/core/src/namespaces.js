/**
 * Constant-time lookup of an attacker-supplied token in a token map.
 *
 * A plain `tokenMap[token]` is a non-constant-time comparison: V8's string
 * hashing and equality short-circuit on the first differing byte, so response
 * timing leaks how much of a valid token the caller guessed. That matters
 * because `serve --cors` is explicitly reachable from other machines.
 *
 * This compares the candidate against EVERY key with a length-normalised,
 * branch-free difference accumulator, so the work is independent of both the
 * match position and the token length. Returns the matching entry, or null.
 */
export function timingSafeTokenLookup(tokenMap, candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  const keys = Object.keys(tokenMap);
  let match = null;
  for (const key of keys) {
    // Compare over a fixed length = max(len(key), len(candidate)); missing
    // bytes count as a difference so equal-prefix but shorter tokens differ.
    const n = Math.max(key.length, candidate.length);
    let diff = key.length ^ candidate.length;
    for (let i = 0; i < n; i++) {
      diff |= (key.charCodeAt(i) || 0) ^ (candidate.charCodeAt(i) || 0);
    }
    // `diff === 0` only when lengths and all bytes match. No early break, and
    // `match` is assigned without branching on the result.
    if (diff === 0) match = tokenMap[key];
  }
  return match;
}

/**
 * Create a namespaced auth resolver that maps tokens to team-scoped access.
 *
 * Auth config format:
 * ```json
 * {
 *   "tokens": {
 *     "admin-token": { "scope": "write", "teams": ["*"] },
 *     "core-token": { "scope": "write", "teams": ["core"] },
 *     "viewer-token": { "scope": "read", "teams": ["*"] }
 *   }
 * }
 * ```
 */
export function createNamespacedAuth(authConfig) {
  if (!authConfig || !authConfig.tokens) {
    throw new Error("authConfig must have a 'tokens' object");
  }

  const tokenMap = authConfig.tokens;

  return function resolveAuth(token, team = null) {
    const entry = timingSafeTokenLookup(tokenMap, token);
    if (!entry) return null;

    const { scope, teams } = entry;

    if (!team || !teams) return scope;

    if (teams.includes("*")) return scope;

    if (teams.includes(team)) return scope;

    return null;
  };
}

/**
 * Create a namespaced auth resolver from a flat { token: scope } map.
 * All tokens get access to all teams.
 */
export function createFlatNamespacedAuth(flatMap) {
  const tokenMap = {};
  for (const [token, scope] of Object.entries(flatMap)) {
    tokenMap[token] = { scope, teams: ["*"] };
  }
  return createNamespacedAuth({ tokens: tokenMap });
}

/**
 * Create a namespaced auth middleware for use with createTokenServer.
 * Returns a function that can be passed as `options.auth` to the server.
 */
export function createNamespacedMiddleware(authConfig, allowedTeams = []) {
  const resolver = createNamespacedAuth(authConfig);

  return function resolveAuth(token, team = null) {
    const scope = resolver(token, team);
    if (!scope) return null;

    if (team && !allowedTeams.includes("*") && !allowedTeams.includes(team)) {
      return null;
    }

    return scope;
  };
}

/**
 * v11.0 org rooms & trust: create an org-aware auth resolver. Auth tokens
 * carry an `org` in addition to scope + teams, and every mesh room is
 * `(org, team)` — org A's write token is null (→ 403 on org B's server).
 *
 * ```json
 * {
 *   "tokens": {
 *     "acme-write":   { "scope": "write", "org": "acme",   "teams": ["*"] },
 *     "globex-view":  { "scope": "read",  "org": "globex", "teams": ["web"] }
 *   }
 * }
 * ```
 *
 * Pass the result as `options.auth` together with `options.org` on
 * `createTokenServer`; the server resolves `auth(token, org)`.
 */
export function createOrgAuth(authConfig) {
  if (!authConfig || !authConfig.tokens) {
    throw new Error("authConfig must have a 'tokens' object");
  }
  const tokenMap = authConfig.tokens;

  function resolveOrgAuth(token, org = null, team = null) {
    const entry = timingSafeTokenLookup(tokenMap, token);
    if (!entry) return null;
    const { scope, org: tokenOrg, teams } = entry;
    if (!scope) return null;
    if (tokenOrg && tokenOrg !== "*" && org && tokenOrg !== org) return null;
    if (!team || !teams) return scope;
    if (teams.includes("*") || teams.includes(team)) return scope;
    return null;
  }
  // Marker consumed by createTokenServer: resolvers flagged orgAware receive
  // `(token, org)` so a foreign org's token resolves to null.
  resolveOrgAuth.orgAware = true;
  return resolveOrgAuth;
}

/**
 * v11.0 room key for the `(org, team)` room model, e.g. `acme/web`.
 */
export function orgRoomKey(org, team = null) {
  return team ? `${org}/${team}` : org;
}
