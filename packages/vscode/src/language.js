/**
 * Build the language index consumed by the pure providers, from MCP tool
 * results. Two calls: `list_tokens` (resolved tree) + `completions`
 * (labels/deprecations). `token_info` is fetched lazily per hover.
 */
export async function buildLanguageIndex(callTool) {
  const tree = await callTool("list_tokens", {});
  const { completions } = await callTool("completions", { kind: "css", max: 100000 });

  const byPath = {};
  const byVariable = {};
  const byHex = {};
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node || {})) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) walk(value, dotted);
      else {
        byPath[dotted] = { path: dotted, value, variable: null, resolved: true };
      }
    }
  };
  walk(tree, "");

  for (const c of completions) {
    if (!byPath[c.path]) byPath[c.path] = { path: c.path, value: c.value, resolved: true };
    byPath[c.path].variable = c.variable;
    byPath[c.path].deprecated = Boolean(c.deprecated);
    byPath[c.path].replacedBy = c.replacedBy || null;
    byVariable[c.variable] = byPath[c.path];
    // Hover on a raw hex literal that exactly matches a token value.
    if (typeof c.value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c.value)) {
      byHex[c.value.toLowerCase()] = byPath[c.path];
    }
  }
  return { byPath, byVariable, byHex, completions };
}

/** Fetch + cache `token_info` for one path. Returns the MCP payload. */
export async function tokenInfo(callTool, cache, path) {
  if (cache[path]) return cache[path];
  try {
    const info = await callTool("token_info", { path });
    if (info && info.color && info.color.hex) {
      cache[info.color.hex.toLowerCase()] = { path, ...info };
    }
    cache[path] = info;
    return info;
  } catch {
    return null;
  }
}
