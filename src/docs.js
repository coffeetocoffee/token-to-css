import { resolveReferences } from "./references.js";
import { deepMerge } from "./merge.js";

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

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dottedRows(tree, prefix = "") {
  const rows = [];
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rows.push(...dottedRows(value, name));
    } else {
      rows.push({ name, value: String(value) });
    }
  }
  return rows;
}

/** Static, searchable docs site built on the `report` data. */
export function buildDocsSite(tokens, options = {}) {
  const tree =
    tokens && typeof tokens === "object" && "$value" in tokens ? tokens.$value : tokens;
  const normalized = normalizeLocal(tree);
  const base = stripThemes(normalized);
  const resolved =
    options.resolve === false
      ? base
      : resolveReferences(base, { reduce: options.reduce !== false });
  const rows = dottedRows(resolved);
  const title = escHtml(options.title || "Design tokens");
  const trs = rows
    .map(
      ({ name, value }) =>
        `<tr data-name="${escHtml(name.toLowerCase())}"><td><code>${escHtml(name)}</code></td>` +
        `<td><code>--${escHtml(name.replace(/\./g, "-"))}</code></td>` +
        `<td>${escHtml(value)}</td>` +
        `<td><span class="sw" style="background:${escHtml(value)}"></span></td></tr>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — docs</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;max-width:72rem}
input{width:100%;padding:.5rem .75rem;font-size:1rem;margin:1rem 0;border:1px solid #d4d4d8;border-radius:.375rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e4e4e7;vertical-align:middle}
code{background:#f4f4f5;padding:.1rem .4rem;border-radius:.25rem}
.sw{display:inline-block;width:1.75rem;height:1.75rem;border-radius:.375rem;border:1px solid #ccc;vertical-align:middle}
.count{color:#71717a}
</style>
</head>
<body>
<h1>${title}</h1>
<p class="count">${rows.length} tokens</p>
<input id="q" type="search" placeholder="Search tokens…" autocomplete="off" />
<table>
<thead><tr><th>Token</th><th>Variable</th><th>Value</th><th>Swatch</th></tr></thead>
<tbody id="rows">
${trs}
</tbody>
</table>
<script>
const q=document.getElementById("q"),rows=[...document.querySelectorAll("#rows tr")];
q.addEventListener("input",()=>{const s=q.value.toLowerCase();for(const r of rows)r.style.display=r.dataset.name.includes(s)?"":"none"});
</script>
</body>
</html>
`;
}

function normalizeLocal(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    if ("$value" in input) return input.$value;
    const out = {};
    for (const [key, value] of Object.entries(input)) out[key] = normalizeLocal(value);
    return out;
  }
  return input;
}

function stripThemes(tree) {
  const out = structuredClone(tree);
  if (out.modes) delete out.modes;
  if (out.themes) delete out.themes;
  if (out.brands) delete out.brands;
  if (out.brand) delete out.brand;
  return out;
}

/** Browseable token explorer page for `serve` (every token + copy buttons). */
export function buildExplorerHTML(tokens, options = {}) {
  const normalized = normalizeLocal(tokens);
  const base = stripThemes(normalized);
  const modeDefs = normalized.modes || normalized.themes || null;
  const resolved =
    options.resolve === false
      ? base
      : resolveReferences(base, { reduce: options.reduce !== false });
  const flat = flatten(resolved);
  const files = options.files || [];
  const rows = Object.entries(flat)
    .map(
      ([name, value]) =>
        `<tr data-name="${escHtml(name.toLowerCase())}"><td><code>--${escHtml(name)}</code></td>` +
        `<td><code>${escHtml(value)}</code></td>` +
        `<td><span class="sw" style="background:${escHtml(value)}"></span></td>` +
        `<td><button data-copy="--${escHtml(name)}: ${escHtml(value)};">copy</button></td></tr>`
    )
    .join("\n");
  const links = files.length
    ? `<ul>${files.map((f) => `<li><a href="/${escHtml(encodeURIComponent(f.name))}">${escHtml(f.name)}</a></li>`).join("")}</ul>`
    : `<p>(no file outputs; use -o path)</p>`;
  const modeNote = modeDefs ? `<p>${Object.keys(modeDefs).length} mode(s): ${escHtml(Object.keys(modeDefs).join(", "))}</p>` : "";
  void deepMerge;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>token-to-css — explorer</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;max-width:72rem}
input{width:100%;padding:.5rem .75rem;font-size:1rem;margin:1rem 0;border:1px solid #d4d4d8;border-radius:.375rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e4e4e7}
code{background:#f4f4f5;padding:.1rem .4rem;border-radius:.25rem}
.sw{display:inline-block;width:1.5rem;height:1.5rem;border-radius:.375rem;border:1px solid #ccc;vertical-align:middle}
button{cursor:pointer}
</style>
</head>
<body>
<h1>token-to-css — explorer</h1>
${modeNote}
<input id="q" type="search" placeholder="Filter tokens…" autocomplete="off" />
<table>
<thead><tr><th>Variable</th><th>Value</th><th>Swatch</th><th></th></tr></thead>
<tbody id="rows">${rows}</tbody>
</table>
<h2>Files</h2>
${links}
  <script>
  const q=document.getElementById("q"),rows=[...document.querySelectorAll("#rows tr")];
  q.addEventListener("input",()=>{const s=q.value.toLowerCase();for(const r of rows)r.style.display=r.dataset.name.includes(s)?"":"none"});
  document.addEventListener("click",async e=>{const b=e.target.closest("[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent="copied!";setTimeout(()=>b.textContent="copy",800)}catch{const t=document.createElement("textarea");t.value=b.dataset.copy;document.body.appendChild(t);t.select();document.execCommand("copy");t.remove()}});
  </script>
  </body>
  </html>
  `;
}

/**
 * Wikipedia-style provenance view: every token with its resolved value, a swatch,
 * and the reverse dependency graph ("used by"). Useful for auditing which tokens
 * depend on a given one before changing it.
 */
export function buildProvenance(tokens, options = {}) {
  const normalized = normalizeLocal(tokens);
  const base = stripThemes(normalized);
  const resolved =
    options.resolve === false ? base : resolveReferences(base, { reduce: options.reduce !== false });
  const rows = dottedRows(resolved);
  const allNames = new Set(rows.map((r) => r.name));
  const rawRows = dottedRows(base);
  const usedBy = {};
  const refRe = /\{([\w.]+)\}/g;
  for (const r of rawRows) {
    let m;
    while ((m = refRe.exec(r.value))) {
      const target = m[1];
      if (allNames.has(target)) (usedBy[target] = usedBy[target] || []).push(r.name);
    }
  }
  const title = escHtml(options.title || "Token provenance");
  const sections = rows
    .map(({ name, value }) => {
      const used = (usedBy[name] || [])
        .map((u) => `<code>${escHtml(u)}</code>`)
        .join(", ") || "<em>unused</em>";
      const swatch = /^(#|rgba?\(|hsl|oklch|oklab|lab|lch)/i.test(value)
        ? `<span class="sw" style="background:${escHtml(value)}"></span>`
        : "";
      return `<section class="tok">
  <h3><code>${escHtml(name)}</code></h3>
  <p>Resolved: <code>${escHtml(value)}</code> ${swatch}</p>
  <p class="used">Used by: ${used}</p>
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}
.tok{border:1px solid #e4e4e7;border-radius:.5rem;padding:1rem 1.25rem;margin:1rem 0}
h3{margin:0 0 .5rem}
code{background:#f4f4f5;padding:.1rem .4rem;border-radius:.25rem}
.used{color:#52525b}
.sw{display:inline-block;width:1.25rem;height:1.25rem;border-radius:.3rem;border:1px solid #ccc;vertical-align:middle}
</style>
</head>
<body>
<h1>${title}</h1>
<p>${rows.length} tokens</p>
${sections}
</body>
</html>
`;
}
