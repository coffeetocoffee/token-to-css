import { mapToBarefoot, BAREFOOT_MAP } from "./presets/barefoot.js";
import { TAILWIND_MAP } from "./presets/tailwind.js";
import { OPENPROPS_MAP } from "./presets/open-props.js";
import { resolveReferences } from "./references.js";
import { validateTokens, TokenValidationError } from "./schema.js";
import { deepMerge } from "./merge.js";
export { parseLocated } from "./locate.js";
export { resolveReferences } from "./references.js";
export { validateTokens, TokenValidationError } from "./schema.js";

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

/**
 * Normalize W3C Design Tokens (`{ "$value": ... }`) into the plain
 * string/number/boolean leaf shape this tool uses internally. Safe to run on
 * already-normal tokens (it returns them unchanged).
 */
export function normalizeW3C(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    if ("$value" in input) return input.$value;
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = normalizeW3C(value);
    }
    return out;
  }
  return input;
}

/** Map flat token names to output CSS variable names. */
export function applyMap(flat, mapObj = {}) {
  const out = {};
  for (const [name, value] of Object.entries(flat)) {
    out[mapObj[name] || `--${name}`] = value;
  }
  return out;
}

function renderCssVars(
  flat,
  { selector = ":root", indent = "  ", sourceComments = false } = {}
) {
  const lines = Object.entries(flat).map(([name, value]) => {
    const path = name.replace(/^--/, "").replace(/-/g, ".");
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
    const path = name.replace(/^--/, "").replace(/-/g, ".");
    const comment = sourceComments ? `/* ${path} */\n` : "";
    return `${comment}$${name}: ${value};`;
  });
  return `${lines.join("\n")}\n`;
}

export function toCSSModules(flat, { sourceComments = false, indent = "  " } = {}) {
  const lines = Object.entries(flat).map(([name, value]) => {
    const path = name.replace(/^--/, "").replace(/-/g, ".");
    const camel = name.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const comment = sourceComments ? `${indent}/* ${path} */\n` : "";
    return `${comment}${indent}${camel}: ${value};`;
  });
  return `:export {\n${lines.join("\n")}\n}\n`;
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

function selectorForBase(options) {
  if (options.format === "barefoot") {
    if (options.theme) return `[data-bf-theme="${options.theme}"]`;
    return options.selector || ":root";
  }
  return options.selector || ":root";
}

function modeSelector(base, mode) {
  return `${base}[data-mode="${mode}"]`;
}

function customMapFor(options) {
  if (options.format === "barefoot") return { ...BAREFOOT_MAP, ...(options.map || {}) };
  if (options.preset === "tailwind") return TAILWIND_MAP;
  if (options.preset === "open-props") return OPENPROPS_MAP;
  return null;
}

function mapFlat(flat, options, customMap) {
  if (options.format === "barefoot") return mapToBarefoot(flat, options.map);
  if (customMap) return applyMap(flat, customMap);
  return flat;
}

function renderJSON(resolvedBase, modeDefs, options) {
  const out = structuredClone(resolvedBase);
  if (modeDefs) {
    const requested =
      options.modes && options.modes.length
        ? options.modes
        : Object.keys(modeDefs);
    out.modes = {};
    for (const m of requested) {
      if (!modeDefs[m]) continue;
      const merged = structuredClone(resolvedBase);
      deepMerge(merged, modeDefs[m]);
      out.modes[m] = options.resolve
        ? resolveReferences(merged, { reduce: options.reduce })
        : merged;
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function buildOutput(tokens, options = {}) {
  const opts = {
    format: "css",
    resolve: true,
    reduce: true,
    validate: true,
    ...options,
  };
  if (opts.validate) validateTokens(tokens);

  const tree = normalizeW3C(tokens);
  const modeKey = tree.modes ? "modes" : tree.themes ? "themes" : null;
  const modeDefs = modeKey ? tree[modeKey] : null;
  let baseTree = tree;
  if (modeKey) {
    baseTree = structuredClone(tree);
    delete baseTree[modeKey];
  }

  const resolvedBase = opts.resolve
    ? resolveReferences(baseTree, { reduce: opts.reduce })
    : baseTree;
  const baseFlat = flattenTokens(resolvedBase);
  const customMap = customMapFor(opts);
  const baseOut = mapFlat(baseFlat, opts, customMap);
  const baseSelector = selectorForBase(opts);

  const blocks = [{ selector: baseSelector, flat: baseOut }];

  if (modeDefs && (opts.format === "css" || opts.format === "barefoot")) {
    const requested =
      opts.modes && opts.modes.length ? opts.modes : Object.keys(modeDefs);
    for (const m of requested) {
      if (!modeDefs[m]) continue;
      const merged = structuredClone(baseTree);
      deepMerge(merged, modeDefs[m]);
      const r = opts.resolve
        ? resolveReferences(merged, { reduce: opts.reduce })
        : merged;
      const f = mapFlat(flattenTokens(r), opts, customMap);
      blocks.push({ selector: modeSelector(baseSelector, m), flat: f });
    }
  }

  let css;
  if (opts.format === "scss") {
    css = toSCSS(baseOut, { sourceComments: opts.sourceComments });
  } else if (opts.format === "css-modules") {
    css = toCSSModules(baseOut, { sourceComments: opts.sourceComments });
  } else if (opts.format === "json") {
    css = renderJSON(resolvedBase, modeDefs, opts);
  } else {
    css = blocks
      .map((b) =>
        renderCssVars(b.flat, {
          selector: b.selector,
          sourceComments: opts.sourceComments,
        })
      )
      .join("");
  }

  return { css, customMap };
}

export function convert(tokens, options = {}) {
  return buildOutput(tokens, options).css;
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

function buildReverse(mapObj) {
  const reverse = {};
  for (const [flatName, varName] of Object.entries(mapObj)) {
    reverse[varName.replace(/^--/, "")] = flatName;
  }
  return reverse;
}

export function buildSourceMap(
  css,
  locations,
  { format = "css", outputFile, sourcesContent = {}, customMap = null } = {}
) {
  const reverse = customMap
    ? buildReverse(customMap)
    : format === "barefoot"
    ? buildReverse(BAREFOOT_MAP)
    : null;
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
    if (reverse) {
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
  const { css, customMap } = buildOutput(tree, options);
  const sourceMap = buildSourceMap(css, locations, {
    format: options.format || "css",
    outputFile: options.outputFile,
    sourcesContent: options.sourcesContent || {},
    customMap,
  });
  return { css, map: sourceMap };
}
