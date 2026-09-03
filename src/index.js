import { mapToBarefoot, BAREFOOT_MAP } from "./presets/barefoot.js";
import { TAILWIND_MAP } from "./presets/tailwind.js";
import { OPENPROPS_MAP } from "./presets/open-props.js";
import { resolveReferences, registerFunction } from "./references.js";
import { validateTokens, TokenValidationError } from "./schema.js";
import { deepMerge } from "./merge.js";
import { lintTokens, checkContract } from "./lint.js";
import {
  buildKit,
  buildKitCSS,
  buildThemeJS,
  buildBindings,
  buildPreviewHTML,
  splitThemes,
  THEME_JS,
} from "./kit.js";
import { buildDocsSite, buildExplorerHTML } from "./docs.js";
import { reverse, reverseStyleDictionary } from "./reverse.js";
export { parseLocated } from "./locate.js";
export { resolveReferences, registerFunction } from "./references.js";
export { validateTokens, TokenValidationError } from "./schema.js";
export { lintTokens, checkContract } from "./lint.js";
export {
  buildKit,
  buildKitCSS,
  buildThemeJS,
  buildBindings,
  buildPreviewHTML,
  splitThemes,
  THEME_JS,
} from "./kit.js";
export { buildDocsSite, buildExplorerHTML } from "./docs.js";
export { reverse, reverseStyleDictionary } from "./reverse.js";
export { applyReversedIntoSource, computeDrift, canSetPath } from "./sync.js";

const registeredFormats = {};

export function registerFormat(name, fn) {
  registeredFormats[name.toLowerCase()] = fn;
}

export function registerPlugin(plugin) {
  if (!plugin || typeof plugin !== "object")
    throw new Error("registerPlugin expects a plugin object");
  if (plugin.name && typeof plugin.name !== "string")
    throw new Error("plugin.name must be a string");
  if (plugin.functions)
    for (const [name, fn] of Object.entries(plugin.functions))
      registerFunction(name, fn);
  if (plugin.formats)
    for (const [name, fn] of Object.entries(plugin.formats))
      registerFormat(name, fn);
  return plugin;
}

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
  if (options.format === "tailwind") return "@theme";
  return options.selector || ":root";
}

function modeSelector(base, mode) {
  return `${base}[data-mode="${mode}"]`;
}

function customMapFor(options) {
  if (options.format === "barefoot") return { ...BAREFOOT_MAP, ...(options.map || {}) };
  if (options.format === "tailwind" || options.preset === "tailwind") return TAILWIND_MAP;
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

function toStyleDictionary(tree) {
  function walk(node) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return { value: node };
  }
  return walk(tree);
}

function typeOf(node) {
  if (typeof node === "number") return "number";
  if (typeof node === "boolean") return "boolean";
  return "string";
}

function toSchema(tree, rootName = "Tokens") {
  function walk(node) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const properties = {};
      for (const [k, v] of Object.entries(node)) properties[k] = walk(v);
      return { type: "object", additionalProperties: false, properties };
    }
    return { type: typeOf(node) };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: rootName,
    ...walk(tree),
  };
}

function toMarkdownRows(tree, prefix = "") {
  const rows = [];
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rows.push(...toMarkdownRows(value, name));
    } else {
      rows.push(`| \`${name}\` | ${value} |`);
    }
  }
  return rows;
}

function toMarkdown(tree, prefix = "") {
  return toMarkdownRows(tree, prefix).join("\n") + "\n";
}

function renderReport(resolvedBase, modeDefs, options) {
  let md = "# Token Report\n\n";
  md += "| Token | Value |\n| --- | --- |\n";
  md += toMarkdown(resolvedBase);
  if (modeDefs) {
    const requested =
      options.modes && options.modes.length
        ? options.modes
        : Object.keys(modeDefs);
    for (const m of requested) {
      if (!modeDefs[m]) continue;
      const merged = structuredClone(resolvedBase);
      deepMerge(merged, modeDefs[m]);
      const r = options.resolve
        ? resolveReferences(merged, { reduce: options.reduce })
        : merged;
      md += `\n## mode: ${m}\n\n| Token | Value |\n| --- | --- |\n`;
      md += toMarkdown(r);
    }
  }
  return md;
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

  const brandKey = tree.brands ? "brands" : tree.brand ? "brand" : null;
  const brandDefs = brandKey ? tree[brandKey] : null;
  if (brandKey) {
    baseTree = structuredClone(baseTree);
    delete baseTree[brandKey];
    if (options.brand && brandDefs[options.brand]) {
      deepMerge(baseTree, brandDefs[options.brand]);
    }
  }

  const resolvedBase = opts.resolve
    ? resolveReferences(baseTree, { reduce: opts.reduce, strict: opts.strict })
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
        ? resolveReferences(merged, { reduce: opts.reduce, strict: opts.strict })
        : merged;
      const f = mapFlat(flattenTokens(r), opts, customMap);
      blocks.push({ selector: modeSelector(baseSelector, m), flat: f });
    }
  }

  if (brandDefs && (opts.format === "css" || opts.format === "barefoot")) {
    const requested =
      opts.brands && opts.brands.length
        ? opts.brands
        : opts.brand
          ? [opts.brand]
          : Object.keys(brandDefs);
    for (const b of requested) {
      if (!brandDefs[b]) continue;
      const merged = structuredClone(baseTree);
      deepMerge(merged, brandDefs[b]);
      const r = opts.resolve
        ? resolveReferences(merged, { reduce: opts.reduce, strict: opts.strict })
        : merged;
      const f = mapFlat(flattenTokens(r), opts, customMap);
      blocks.push({
        selector: `${baseSelector}[data-brand="${b}"]`,
        flat: f,
      });
    }
  }

  let css;
  if (opts.format === "scss") {
    css = toSCSS(baseOut, { sourceComments: opts.sourceComments });
  } else if (opts.format === "css-modules") {
    css = toCSSModules(baseOut, { sourceComments: opts.sourceComments });
  } else if (opts.format === "json") {
    css = renderJSON(resolvedBase, modeDefs, opts);
  } else if (opts.format === "style-dictionary") {
    css = `${JSON.stringify(toStyleDictionary(resolvedBase), null, 2)}\n`;
  } else if (opts.format === "schema") {
    css = `${JSON.stringify(toSchema(baseTree), null, 2)}\n`;
  } else if (opts.format === "report") {
    css = renderReport(resolvedBase, modeDefs, opts);
  } else if (opts.format === "docs") {
    css = buildDocsSite(tokens, opts);
  } else if (opts.format === "ts") {
    css = buildBindings(tokens, opts).ts;
  } else if (opts.format === "js") {
    css = buildBindings(tokens, opts).js;
  } else if (opts.format && registeredFormats[opts.format]) {
    css = registeredFormats[opts.format](baseOut, {
      ...opts,
      customMap,
      resolvedBase,
      modeDefs,
    });
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

export function diffTokens(a, b) {
  const fa = flattenTokens(
    resolveReferences(normalizeW3C(a), { reduce: true })
  );
  const fb = flattenTokens(
    resolveReferences(normalizeW3C(b), { reduce: true })
  );
  const added = {};
  const removed = {};
  const changed = {};
  for (const [k, v] of Object.entries(fb)) if (!(k in fa)) added[k] = v;
  for (const [k, v] of Object.entries(fa)) if (!(k in fb)) removed[k] = v;
  for (const [k, v] of Object.entries(fb))
    if (k in fa && fa[k] !== v) changed[k] = { from: fa[k], to: v };
  return { added, removed, changed };
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
