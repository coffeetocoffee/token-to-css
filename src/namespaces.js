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
    const entry = tokenMap[token];
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
