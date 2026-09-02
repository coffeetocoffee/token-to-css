import { mapToBarefoot } from "./presets/barefoot.js";
import { resolveReferences } from "./references.js";
import { validateTokens } from "./schema.js";

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
