import { resolveReferences } from "./references.js";
import { deepMerge } from "./merge.js";
import { validateTokens } from "./schema.js";

function kebab(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function flatten(input, prefix = []) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const path = [...prefix, kebab(key)];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, path));
    } else if (value !== null && value !== undefined) {
      out[path.join("-")] = String(value);
    }
  }
  return out;
}

function normalizeW3C(input) {
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

function renderVars(flat, { selector = ":root", indent = "  " } = {}) {
  const lines = Object.entries(flat).map(
    ([name, value]) => `${indent}--${name.replace(/^--/, "")}: ${value};`
  );
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

function camel(name) {
  return name
    .replace(/^--/, "")
    .replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escJs(s) {
  return JSON.stringify(String(s));
}

/**
 * Split a token tree into base + mode defs + brand defs.
 */
export function splitThemes(tokens) {
  const tree = normalizeW3C(tokens);
  const modeKey = tree.modes ? "modes" : tree.themes ? "themes" : null;
  const brandKey = tree.brands ? "brands" : tree.brand ? "brand" : null;
  let base = tree;
  if (modeKey) {
    base = structuredClone(base);
    delete base[modeKey];
  }
  if (brandKey) {
    base = structuredClone(base);
    delete base[brandKey];
  }
  return {
    base,
    modes: modeKey ? tree[modeKey] : {},
    brands: brandKey ? tree[brandKey] : {},
  };
}

/**
 * Compiled CSS for a kit: base :root plus every mode as
 * :root[data-mode], every brand as :root[data-brand], and every
 * mode×brand combination.
 */
export function buildKitCSS(tokens, options = {}) {
  const opts = { selector: ":root", resolve: true, reduce: true, validate: true, ...options };
  if (opts.validate) validateTokens(tokens);
  const { base, modes, brands } = splitThemes(tokens);
  const modeNames = opts.modes && opts.modes.length ? opts.modes.filter((m) => modes[m]) : Object.keys(modes || {});
  const brandNames =
    opts.brands && opts.brands.length
      ? opts.brands.filter((b) => brands[b])
      : opts.brand
        ? [opts.brand].filter((b) => brands[b])
        : Object.keys(brands || {});
  const sel = opts.selector || ":root";

  const resolve = (t) =>
    opts.resolve ? resolveReferences(t, { reduce: opts.reduce, strict: opts.strict }) : t;

  let css = renderVars(flatten(resolve(structuredClone(base))), { selector: sel });
  for (const m of modeNames) {
    const merged = structuredClone(base);
    deepMerge(merged, modes[m]);
    css += renderVars(flatten(resolve(merged)), { selector: `${sel}[data-mode="${m}"]` });
  }
  for (const b of brandNames) {
    const merged = structuredClone(base);
    deepMerge(merged, brands[b]);
    css += renderVars(flatten(resolve(merged)), { selector: `${sel}[data-brand="${b}"]` });
  }
  for (const m of modeNames) {
    for (const b of brandNames) {
      const merged = structuredClone(base);
      deepMerge(merged, brands[b]);
      deepMerge(merged, modes[m]);
      css += renderVars(flatten(resolve(merged)), {
        selector: `${sel}[data-mode="${m}"][data-brand="${b}"]`,
      });
    }
  }
  return { css, modes: modeNames, brands: brandNames };
}

/** ~1KB runtime that flips themes via data attributes + localStorage. */
export const THEME_JS = `(()=>{const d=document.documentElement;const g=k=>{try{return localStorage.getItem("ttc-"+k)}catch(e){return null}};const s=(k,v)=>{try{localStorage.setItem("ttc-"+k,v)}catch(e){}};function set(o){o=o||{};if(o.mode!=null){d.dataset.mode=o.mode;s("mode",o.mode)}if(o.brand!=null){d.dataset.brand=o.brand;s("brand",o.brand)}const m=d.dataset.mode||"",b=d.dataset.brand||"";d.dataset.theme=[b,m].filter(Boolean).join("-")||"default";try{d.style.colorScheme=/dark/.test(m)?"dark":"light"}catch(e){}}function init(){set({mode:g("mode")||d.dataset.mode||"",brand:g("brand")||d.dataset.brand||""})}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();window.ttcTheme={set,init};window.setTheme=set;})();\n`;

export function buildThemeJS() {
  return THEME_JS;
}

/** Typed bindings (tokens.ts / tokens.js) from the resolved base tree. */
export function buildBindings(tokens, options = {}) {
  const { base } = splitThemes(tokens);
  const resolved = options.resolve === false ? base : resolveReferences(normalizeW3C(base), {
    reduce: options.reduce !== false,
  });
  const flat = flatten(resolved);
  const names = Object.keys(flat).sort();
  const constName = (n) => camel(n);

  const tsLines = [
    `// Generated by token-to-css kit — do not edit.`,
    `export const tokens = {`,
    ...names.map((n) => `  ${escJs(n)}: ${escJs(flat[n])},`),
    `} as const;`,
    ``,
    `export type TokenName = ${names.length ? names.map((n) => escJs(n)).join(" | ") : "never"};`,
    `export type TokenMap = Record<TokenName, string>;`,
    ``,
    ...names.map((n) => `export const ${constName(n)}: string = ${escJs(flat[n])};`),
    ``,
  ];
  const jsLines = [
    `// Generated by token-to-css kit — do not edit.`,
    `export const tokens = {`,
    ...names.map((n) => `  ${escJs(n)}: ${escJs(flat[n])},`),
    `};`,
    ``,
    ...names.map((n) => `export const ${constName(n)} = ${escJs(flat[n])};`),
    ``,
  ];
  return { ts: tsLines.join("\n"), js: jsLines.join("\n"), flat, names };
}

/** Self-contained preview page for a kit (inline CSS + theme switcher). */
export function buildPreviewHTML(tokens, options = {}) {
  const { css, modes, brands } = buildKitCSS(tokens, options);
  const { flat } = buildBindings(tokens, options);
  const title = escHtml(options.title || "Design tokens — preview");
  const rows = Object.entries(flat)
    .map(
      ([name, value]) =>
        `<div class="tok"><span class="sw" style="background:var(--${escHtml(name)})"></span>` +
        `<code>--${escHtml(name)}</code><code class="val">${escHtml(value)}</code></div>`
    )
    .join("\n");
  const modeOpts = modes.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("");
  const brandOpts = brands.map((b) => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
${css}
body{font-family:system-ui,sans-serif;margin:2rem;background:var(--color-background,white);color:var(--color-text,black)}
.toolbar{display:flex;gap:1rem;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap}
.tok{display:flex;gap:.75rem;align-items:center;padding:.4rem 0;border-bottom:1px solid #eee}
.sw{width:2rem;height:2rem;border-radius:.375rem;border:1px solid #ccc;background-clip:padding-box}
code{background:#f4f4f5;padding:.1rem .4rem;border-radius:.25rem}
.val{color:#52525b}
</style>
</head>
<body>
<h1>${title}</h1>
<div class="toolbar">
<label>mode <select id="ttc-mode"><option value="">(default)</option>${modeOpts}</select></label>
<label>brand <select id="ttc-brand"><option value="">(default)</option>${brandOpts}</select></label>
</div>
<div>${rows}</div>
<script>
${THEME_JS}
document.getElementById("ttc-mode").addEventListener("change",e=>window.setTheme({mode:e.target.value}));
document.getElementById("ttc-brand").addEventListener("change",e=>window.setTheme({brand:e.target.value}));
</script>
</body>
</html>
`;
}

/** Build every kit artifact in memory. */
export function buildKit(tokens, options = {}) {
  const { css, modes, brands } = buildKitCSS(tokens, options);
  const js = buildThemeJS();
  const html = buildPreviewHTML(tokens, options);
  const { ts, js: jsBindings, flat, names } = buildBindings(tokens, options);
  return { css, js, html, ts, jsBindings, modes, brands, flat, names };
}
