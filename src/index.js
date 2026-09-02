import { mapToBarefoot, BAREFOOT_MAP } from "./presets/barefoot.js";
import { resolveReferences } from "./references.js";
import { validateTokens } from "./schema.js";
export { parseLocated } from "./locate.js";

function kebab(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function flattenTokens(input, prefix = []) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const path = [...prefix, kebab(key)];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenTokens(value, path));
    } else if (value !== null && value !== undefined) {
      out[path.join("-")] = String(value);
    }
  }
  return out;
}

function renderCssVars(
  flat,
  { selector = ":root", indent = "  ", sourceComments = false } = {}
) {
  const lines = Object.entries(flat).map(([name, value]) => {
    const path = name.replace(/-/g, ".");
    const comment = sourceComments ? `${indent}/* ${path} */\n` : "";
    return `${comment}${indent}--${name.replace(/^--/, "")}: ${value};`;
  });
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

export function toCSS(flat, options = {}) {
  return renderCssVars(flat, options);
}

export function toSCSS(flat, { sourceComments = false } = {}) {
  const lines = Object.entries(flat).map(([name, value]) => {
    const path = name.replace(/-/g, ".");
    const comment = sourceComments ? `/* ${path} */\n` : "";
    return `${comment}$${name}: ${value};`;
  });
  return `${lines.join("\n")}\n`;
}

export function toBarefoot(flat, options = {}) {
  const mapped = mapToBarefoot(flat, options.map);
  const theme = options.theme;
  const selector = theme
    ? `[data-bf-theme="${theme}"]`
    : options.selector || ":root";
  return (
    `/* barefoot-css theme tokens */\n` +
    renderCssVars(mapped, { selector, sourceComments: options.sourceComments })
  );
}

export function convert(
  tokens,
  {
    format = "css",
    theme,
    selector,
    map,
    resolve = true,
    reduce = true,
    validate = true,
    sourceComments = false,
  } = {}
) {
  if (validate) validateTokens(tokens);
  const tree = resolve ? resolveReferences(tokens, { reduce }) : tokens;
  const flat = flattenTokens(tree);
  switch (format) {
    case "scss":
      return toSCSS(flat, { sourceComments });
    case "barefoot":
      return toBarefoot(flat, { theme, selector, map, sourceComments });
    case "css":
    default:
      return toCSS(flat, { selector, sourceComments });
  }
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toVLQ(n) {
  let vlq = n < 0 ? ((-n) << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += BASE64[digit];
  } while (vlq > 0);
  return out;
}

function buildReverseBarefoot(customMap = {}) {
  const merged = { ...BAREFOOT_MAP, ...customMap };
  const reverse = {};
  for (const [token, varName] of Object.entries(merged)) {
    reverse[varName.replace(/^--/, "")] = token;
  }
  return reverse;
}

export function buildSourceMap(
  css,
  locations,
  { format = "css", outputFile, sourcesContent = {}, customMap = {} } = {}
) {
  const reverse = format === "barefoot" ? buildReverseBarefoot(customMap) : null;
  const sources = [];
  const sourceContentList = [];
  function fileIndex(file) {
    let idx = sources.indexOf(file);
    if (idx === -1) {
      idx = sources.length;
      sources.push(file);
      sourceContentList.push(
        sourcesContent[file] != null ? sourcesContent[file] : null
      );
    }
    return idx;
  }
  const varRe = format === "scss" ? /^\s*\$([\w-]+)\s*:/ : /^\s*--([\w-]+)\s*:/;
  const groups = css.split("\n").map((line) => {
    const m = line.match(varRe);
    if (!m) return "";
    let flatName = m[1];
    if (format === "barefoot") {
      const rev = reverse[flatName];
      if (!rev) return "";
      flatName = rev;
    }
    const loc = locations[flatName];
    if (!loc) return "";
    const si = fileIndex(loc.file);
    return toVLQ(0) + toVLQ(si) + toVLQ(loc.line - 1) + toVLQ(0);
  });
  return {
    version: 3,
    file: outputFile || "output.css",
    sources,
    sourcesContent: sourceContentList,
    names: [],
    mappings: groups.join(";"),
  };
}

export function convertToMap(tree, locations, options = {}) {
  const {
    format = "css",
    theme,
    selector,
    map,
    resolve = true,
    reduce = true,
    validate = true,
    sourceComments = false,
    outputFile,
    sourcesContent = {},
  } = options;
  if (validate) validateTokens(tree);
  const resolved = resolve ? resolveReferences(tree, { reduce }) : tree;
  const flat = flattenTokens(resolved);
  let css;
  if (format === "scss") css = toSCSS(flat, { sourceComments });
  else if (format === "barefoot")
    css = toBarefoot(flat, { theme, selector, map, sourceComments });
  else css = toCSS(flat, { selector, sourceComments });
  const sourceMap = buildSourceMap(css, locations, {
    format,
    outputFile,
    sourcesContent,
    customMap: map,
  });
  return { css, map: sourceMap };
}

