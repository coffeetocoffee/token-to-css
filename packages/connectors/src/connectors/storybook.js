/**
 * Storybook connector (v8.0 Universal Connector Hub).
 *
 * Translates a token tree into a Storybook consumable shape: the full resolved
 * token tree plus a mapped `theme` object of the well-known Storybook manager
 * theme keys (colorPrimary, appBg, textColor, ...). The `tokens` field is the
 * canonical, lossless representation; `theme` is a convenience projection.
 *
 * Pure transforms (`tokensToStorybookTheme` / `storybookThemeToTokens`) are
 * transport-agnostic and unit-testable without a network. `push`/`pull` talk to
 * a configurable `url` (a Storybook manager endpoint or any adapter that speaks
 * JSON) when a `fetchImpl` is supplied.
 *
 * Experimental.
 */
import { toTransportTree, registerConnector } from "./connect.js";

// Well-known Storybook manager theme keys sourced from token paths.
const THEME_MAP = {
  colorPrimary: "color.primary",
  colorSecondary: "color.secondary",
  appBg: "color.background",
  appContentBg: "color.surface",
  appBorderColor: "color.border",
  textColor: "color.text",
  textInverseColor: "color.textInverse",
  fontBase: "font.base",
  fontCode: "font.code",
  appBorderRadius: "radius.sm",
};

function getByPath(node, path) {
  let cur = node;
  for (const p of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function tokensToStorybookTheme(tokens) {
  const tree = toTransportTree(tokens);
  const theme = {};
  for (const [key, path] of Object.entries(THEME_MAP)) {
    const v = getByPath(tree, path);
    if (v !== undefined) theme[key] = v;
  }
  return { tokens: tree, theme };
}

export function storybookThemeToTokens(doc) {
  if (doc && doc.tokens) return doc.tokens;
  // Best-effort reconstruction from a projected theme object.
  const out = {};
  for (const [key, path] of Object.entries(THEME_MAP)) {
    if (doc && doc[key] !== undefined) {
      const parts = path.split(".");
      let cur = out;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = cur[parts[i]] || {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = doc[key];
    }
  }
  return out;
}

/**
 * Opt-in Storybook connector. Registers a `storybook` output format and returns
 * a `push`/`pull` object that talks to a Storybook adapter endpoint.
 */
export function registerStorybookConnector({ fetchImpl, url, token } = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  async function pull() {
    if (!fetchFn) throw new Error("storybook connector: no fetch implementation available");
    if (!url) throw new Error("storybook connector: no url configured");
    const res = await fetchFn(url, { headers: authHeaders(token) });
    if (!res.ok) throw new Error(`storybook pull failed: ${res.status}`);
    return storybookThemeToTokens(await res.json());
  }

  async function push(tree) {
    if (!fetchFn) throw new Error("storybook connector: no fetch implementation available");
    if (!url) throw new Error("storybook connector: no url configured");
    const res = await fetchFn(url, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(tokensToStorybookTheme(tree)),
    });
    if (!res.ok) throw new Error(`storybook push failed: ${res.status}`);
    return res.json();
  }

  registerConnector({
    name: "storybook",
    pull,
    push,
    formats: {
      storybook: (_flat, opts) => {
        const tree = opts && opts.resolvedBase ? opts.resolvedBase : {};
        return JSON.stringify(tokensToStorybookTheme(tree), null, 2);
      },
    },
  });
  return { pull, push, tokensToStorybookTheme, storybookThemeToTokens };
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}
