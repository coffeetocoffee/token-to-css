import {
  diffTokens,
  classifyRelease,
  resolveReferences,
  normalizeW3C,
  convert,
} from "./index.js";
import {
  generateCodemod,
  applyCodemod,
  getImpactGraph,
  getTransitiveDependents,
} from "./migrate.js";
import { parseColor } from "./color.js";
import { getDeprecations } from "./governance.js";

const RESERVED_KEYS = new Set(["modes", "themes", "brands", "brand", "teams"]);

// Colors parseColor actually understands (hsl() is left to CSS/the resolver).
const COLOR_LIKE = /^(#|rgba?\(|oklch|oklab|lab|lch)/i;
const DIMENSION = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i;

function kebab(str) {
  return String(str)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/** Walk a RAW tree (W3C `$value` leaves included) collecting dotted paths. */
function flattenDotted(input, prefix = [], out = {}) {
  for (const [key, value] of Object.entries(input || {})) {
    const path = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$value" in value) out[path.join(".")] = value.$value;
      else flattenDotted(value, path, out);
    } else if (value !== null && value !== undefined) {
      out[path.join(".")] = value;
    }
  }
  return out;
}

function stripReserved(tree) {
  const out = structuredClone(tree);
  for (const k of RESERVED_KEYS) delete out[k];
  return out;
}

function getRawLeaf(node, parts) {
  let cur = node;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === "object" && "$value" in cur) return cur.$value;
  return cur;
}

function setRawLeaf(node, parts, value) {
  let cur = node;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    if (next == null) {
      cur[p] = {};
    } else if (typeof next !== "object" || Array.isArray(next) || "$value" in next) {
      throw new Error(`path "${parts.slice(0, i + 1).join(".")}" collides with an existing leaf`);
    }
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  const existing = cur[last];
  if (existing && typeof existing === "object" && "$value" in existing) {
    existing.$value = value;
  } else {
    cur[last] = value;
  }
}

function rawPathExists(source, parts) {
  let cur = source;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return false;
    cur = cur[p];
  }
  return cur !== undefined;
}

/**
 * Validate a proposed token value against the tree:
 * - every `{dotted.path}` reference must exist in the source tree (unknown refs
 *   are rejected and the valid token list is returned);
 * - color-looking literals must parse in the color engine.
 * Returns a list of `{ code, message?, ref?, valid? }` errors (empty = valid).
 */
export function validateEditValue(value, tree) {
  const errors = [];
  if (value === undefined || value === null || String(value).trim() === "") {
    errors.push({ code: "empty-value", message: "value is required" });
    return errors;
  }
  const str = String(value);
  const flat = flattenDotted(normalizeW3C(tree));
  const valid = Object.keys(flat).sort();
  const refRe = /\{([\w.]+)\}/g;
  let m;
  while ((m = refRe.exec(str))) {
    if (!flat[m[1]]) {
      errors.push({
        code: "unknown-ref",
        ref: m[1],
        valid,
        message: `unknown reference {${m[1]}}`,
      });
    }
  }
  if (COLOR_LIKE.test(str.trim())) {
    const parsed = parseColor(str.trim());
    if (!parsed && !refRe.test(str)) {
      errors.push({ code: "bad-color", message: `not a parseable color: ${str}` });
    }
  }
  return errors;
}

/**
 * Apply an editor edit to a source tree (pure — returns a new tree).
 *
 * `edit` is one of:
 * - `{ path, value, mode?, brand? }` — set a value; with `mode`/`brand` the
 *   write lands in `modes.<m>` / `brands.<b>` (an "override here" when the
 *   scope subtree has no such token yet), never in the base tree.
 * - `{ rename: { from, to } }` — move a leaf and update every `{ref}` via the
 *   v7 codemod engine.
 *
 * Returns `{ source, changed }` where `changed` describes the edit
 * (`{ type, path, scope, from, to, override?, creates? }`).
 */
export function buildEditCommit(source, edit = {}) {
  const out = structuredClone(source);
  if (edit.rename) {
    const { from, to } = edit.rename;
    if (getRawLeaf(out, to.split(".")) !== undefined) {
      throw new Error(`rename target "${to}" collides with an existing leaf`);
    }
    const codemod = generateCodemod(source, { from, to });
    const { tree, changes } = applyCodemod(out, codemod);
    return {
      source: tree,
      changed: { type: "rename", from, to, scope: "base", operations: changes.length },
    };
  }
  const { path, value, mode, brand } = edit;
  if (!path) throw new Error("edit.path is required");
  if (value === undefined) throw new Error("edit.value is required");
  const parts = path.split(".");
  let scopeLabel = "base";
  let container = out;
  if (mode != null && mode !== "") {
    const key = out.modes ? "modes" : out.themes ? "themes" : "modes";
    out[key] = out[key] || {};
    out[key][mode] = out[key][mode] || {};
    container = out[key][mode];
    scopeLabel = `mode:${mode}`;
  } else if (brand != null && brand !== "") {
    const key = out.brands ? "brands" : out.brand ? "brand" : "brands";
    out[key] = out[key] || {};
    out[key][brand] = out[key][brand] || {};
    container = out[key][brand];
    scopeLabel = `brand:${brand}`;
  }
  const existing = getRawLeaf(container, parts);
  setRawLeaf(container, parts, value);
  return {
    source: out,
    changed: {
      type: "value",
      path,
      scope: scopeLabel,
      from: existing === undefined ? null : existing,
      to: value,
      override: scopeLabel !== "base" && existing === undefined,
      creates: existing === undefined,
    },
  };
}

/**
 * Governance-aware impact for one token: direct dependents, transitive
 * dependents (v7 impact graph), and deprecation info (`deprecated`,
 * `replacedBy`) so the editor can default an edit to its migration path.
 */
export function editImpact(source, path) {
  const direct = getImpactGraph(source)[path] || [];
  const transitive = getTransitiveDependents(source, path);
  const node = getRawLeaf(source, path.split("."));
  const nodeObj =
    (() => {
      let cur = source;
      for (const p of path.split(".")) {
        if (cur == null || typeof cur !== "object") return null;
        cur = cur[p];
      }
      return cur;
    })() || null;
  const deprecated = Boolean(nodeObj && typeof nodeObj === "object" && nodeObj.deprecated);
  return {
    direct,
    transitive,
    deprecated,
    replacedBy: deprecated ? nodeObj.replacedBy || null : null,
    value: node,
  };
}

/**
 * Diff-before-commit: dry-run an edit and return everything the editor UI
 * needs before a write — validation errors, the resolved `diffTokens` diff,
 * the `classifyRelease` semver verdict, impact, and (for renames) the
 * ready-to-run v7 codemod. Never mutates the source.
 *
 * `blocked` is true when the verdict is major (a removal) and the caller has
 * not explicitly confirmed it.
 */
export function previewEdit(source, edit = {}) {
  const errors = [];
  const renaming = Boolean(edit.rename);
  const targetPath = renaming ? edit.rename.from : edit.path;

  if (renaming) {
    if (!edit.rename.from || !edit.rename.to) {
      errors.push({ code: "bad-rename", message: "rename requires from and to" });
    }
  } else {
    errors.push(...validateEditValue(edit.value, source));
  }

  let nextSource = null;
  let changed = null;
  if (errors.length === 0) {
    try {
      const commit = buildEditCommit(source, edit);
      nextSource = commit.source;
      changed = commit.changed;
    } catch (err) {
      errors.push({ code: "commit-failed", message: err.message });
    }
  }

  let resolveErrors = [];
  let diff = { added: {}, removed: {}, changed: {} };
  let verdict = { bump: "none", removed: [], changed: [], added: [] };
  if (nextSource) {
    try {
      resolveReferences(normalizeW3C(nextSource), { reduce: true });
    } catch (err) {
      resolveErrors = [{ code: "resolve-failed", message: err.message }];
      errors.push(...resolveErrors);
    }
    diff = diffTokens(source, nextSource);
    verdict = classifyRelease(source, nextSource);
  }

  const blocked = verdict.bump === "major" && !edit.confirmed;
  const impact = targetPath ? editImpact(source, targetPath) : null;
  const codemod = renaming
    ? generateCodemod(source, { from: edit.rename.from, to: edit.rename.to })
    : null;

  return { ok: errors.length === 0, errors, changed, diff, verdict, blocked, impact, codemod };
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The v10.5 Visual Token Editor — the explorer page, upgraded to be editable.
 * Served by `serve` at `GET /editor`. Reuses the existing write scope
 * (`POST /tokens`) and the dry-run `POST /editor/preview`; no new protocol.
 */
export function buildEditorHTML(tokens, options = {}) {
  const source = normalizeW3C(tokens);
  const base = stripReserved(source);
  const resolved = resolveReferences(structuredClone(base), { reduce: true });
  const flat = flattenDotted(resolved);
  const modeDefs = source.modes || source.themes || null;
  const brandDefs = source.brands || source.brand || null;
  // Deprecation metadata lives on the RAW tree's `$value` leaves —
  // `normalizeW3C` strips it, so collect from the raw input.
  const deprecations = getDeprecations(tokens);
  const depByKebab = {};
  for (const d of deprecations) depByKebab[d.path.split(".").map(kebab).join("-")] = d.replacedBy;
  const css = convert(base, { format: "css" });

  const rows = Object.entries(flat)
    .map(([dottedPath, value]) => {
      const kebabName = dottedPath.split(".").map(kebab).join("-");
      const isColor = COLOR_LIKE.test(value.trim()) && parseColor(value.trim());
      const dim = DIMENSION.exec(value.trim());
      const kind = isColor ? "color" : dim ? "dimension" : "text";
      const dep = depByKebab[kebabName];
      const depNote = dep
        ? `<span class="dep" title="deprecated — use {${escHtml(dep)}}">deprecated → <code>{${escHtml(dep)}}</code></span>`
        : "";
      return `<tr data-var="${escHtml(kebabName)}" data-path="${escHtml(dottedPath)}" data-kind="${kind}" data-dep="${escHtml(dep || "")}">
<td><code>--${escHtml(kebabName)}</code>${depNote}</td>
<td class="ctrl">
  <input class="val" data-var="${escHtml(kebabName)}" value="${escHtml(value)}" ${options.editable === false ? "disabled" : ""} />
  ${isColor ? `<input type="color" class="pick" value="${escHtml(/^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : "#888888")}" ${options.editable === false ? "disabled" : ""} />` : ""}
  ${kind === "dimension" && options.editable !== false ? `<button class="step" data-step="-1" title="-10%">−</button><button class="step" data-step="1" title="+10%">+</button>` : ""}
  <span class="sw" style="background:${escHtml(value)}"></span>
</td>
<td class="ops">
  <button class="review" data-var="${escHtml(kebabName)}">review</button>
  <button class="commit" data-var="${escHtml(kebabName)}" ${options.editable === false ? "disabled" : ""}>commit</button>
  <button class="rename" data-var="${escHtml(kebabName)}" ${options.editable === false ? "disabled" : ""}>rename…</button>
</td>
</tr>`;
    })
    .join("\n");

  const modeOpts = modeDefs
    ? Object.keys(modeDefs).map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("")
    : "";
  const brandOpts = brandDefs
    ? Object.keys(brandDefs).map((b) => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join("")
    : "";

  const payload = {
    editable: options.editable !== false,
    canary: Boolean(options.canary),
    deprecations: depByKebab,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>token-to-css — visual token editor</title>
<style id="tokens-css">
${css}
</style>
<style>
body{font-family:system-ui,sans-serif;margin:0;display:grid;grid-template-columns:minmax(30rem,2fr) minmax(16rem,1fr)}
main{padding:2rem;max-width:60rem}
aside{border-left:1px solid #e4e4e7;padding:2rem;position:sticky;top:0;height:100vh;box-sizing:border-box;overflow:auto}
input[type=search]{width:100%;padding:.5rem .75rem;font-size:1rem;margin:1rem 0;border:1px solid #d4d4d8;border-radius:.375rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #e4e4e7;vertical-align:middle}
code{background:#f4f4f5;padding:.1rem .4rem;border-radius:.25rem}
.sw{display:inline-block;width:1.25rem;height:1.25rem;border-radius:.3rem;border:1px solid #ccc;vertical-align:middle}
.val{width:16rem;padding:.25rem .4rem;border:1px solid #d4d4d8;border-radius:.3rem;font:inherit}
.val:disabled{background:#f4f4f5;color:#a1a1aa}
.pick,.step{margin-left:.25rem}
button{cursor:pointer;font:inherit;padding:.2rem .5rem;border:1px solid #d4d4d8;border-radius:.3rem;background:white}
button:disabled{cursor:not-allowed;opacity:.5}
.dirty{background:#fef9c3}
.toolbar{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem}
.dep{color:#b45309;font-size:.75rem;margin-left:.5rem}
#panel{border:1px solid #e4e4e7;border-radius:.5rem;padding:1rem;margin:1rem 0;white-space:pre-wrap;font-size:.85rem}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.75rem;font-weight:600}
.badge.minor{background:#dbeafe;color:#1d4ed8}
.badge.major{background:#fee2e2;color:#b91c1c}
.badge.patch{background:#dcfce7;color:#15803d}
.badge.none{background:#f4f4f5;color:#52525b}
.err{color:#b91c1c}
.ok{color:#15803d}
</style>
</head>
<body>
<main>
<h1>Visual token editor</h1>
<div class="toolbar">
<label>mode <select id="mode"><option value="">(base)</option>${modeOpts}</select></label>
<label>brand <select id="brand"><option value="">(base)</option>${brandOpts}</select></label>
<label>channel <select id="channel"><option value="stable">stable</option>${payload.canary ? '<option value="canary">canary</option>' : ""}</select></label>
${options.auth === true ? '<input id="bearer" placeholder="bearer token" type="password" />' : ""}
<button id="cancel">cancel edits</button>
<span id="writable" class="${payload.editable ? "ok" : "err"}">${payload.editable ? "write scope" : "read-only (write scope required)"}</span>
</div>
<input id="q" type="search" placeholder="Filter tokens…" autocomplete="off" />
<table>
<thead><tr><th>Variable</th><th>Value</th><th></th></tr></thead>
<tbody id="rows">
${rows}
</tbody>
</table>
<div id="panel" hidden></div>
</main>
<aside>
<h2>Live preview</h2>
<p class="ok">Draft values apply here only — the source file is untouched until commit.</p>
<div id="preview">
<div class="card a">primary card</div>
<div class="card b">surface card</div>
<button class="pv">button</button>
</div>
</aside>
<style id="draft"></style>
<script type="application/json" id="payload">${JSON.stringify(payload).split("</").join("<\\/")}</script>
<script>
var P = JSON.parse(document.getElementById("payload").textContent);
var $ = function(s, r){ return (r||document).querySelector(s); };
var rows = Array.prototype.slice.call(document.querySelectorAll("#rows tr"));
var draft = {};
function draftCss(){
  var parts = [];
  for (var v in draft) parts.push("--" + v + ":" + draft[v]);
  $("#draft").textContent = parts.length ? ":root{" + parts.join(";") + "}" : "";
}
function scope(){ return { mode: $("#mode").value, brand: $("#brand").value }; }
function commitBody(path, value, sc){
  var parts = path.split(".");
  var leaf = {}, cur = leaf;
  for (var i = 0; i < parts.length - 1; i++){ cur[parts[i]] = {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = value;
  if (sc.mode) return { modes: (function(){ var m = {}; m[sc.mode] = leaf; return m; })() };
  if (sc.brand) return { brands: (function(){ var b = {}; b[sc.brand] = leaf; return b; })() };
  return leaf;
}
function dotted(varName){ return rowPaths[varName] || varName.split("-").join("."); }
var rowPaths = {};
rows.forEach(function(r){ rowPaths[r.dataset.var] = r.dataset.path; });
function api(path, opts){
  opts = opts || {};
  var h = { "content-type": "application/json" };
  var tok = $("#bearer") && $("#bearer").value;
  if (tok) h["authorization"] = "Bearer " + tok;
  return fetch(path, Object.assign({}, opts, { headers: h }));
}
rows.forEach(function(row){
  var v = row.dataset.var, input = $(".val", row), pick = $(".pick", row);
  if (pick) pick.addEventListener("input", function(){
    input.value = pick.value; input.classList.add("dirty");
    draft[v] = input.value; draftCss();
  });
  input.addEventListener("input", function(){
    input.classList.add("dirty");
    draft[v] = input.value; draftCss();
    if (pick && /^#[0-9a-f]{6}$/i.test(input.value.trim())) pick.value = input.value.trim();
  });
  Array.prototype.forEach.call(row.querySelectorAll(".step"), function(btn){
    btn.addEventListener("click", function(){
      var m = /^(-?\\d+(?:\\.\\d+)?)([a-z%]*)$/i.exec(input.value.trim());
      if (!m) return;
      var n = parseFloat(m[1]);
      n = Math.round((n * (btn.dataset.step === "1" ? 1.1 : 1 / 1.1)) * 1000) / 1000;
      input.value = n + m[2];
      input.dispatchEvent(new Event("input"));
    });
  });
});
document.getElementById("q").addEventListener("input", function(){
  var s = this.value.toLowerCase();
  rows.forEach(function(r){ r.style.display = r.dataset.var.indexOf(s) >= 0 ? "" : "none"; });
});
document.getElementById("cancel").addEventListener("click", function(){
  draft = {}; draftCss();
  rows.forEach(function(r){ var i = $(".val", r); i.value = i.defaultValue; i.classList.remove("dirty"); });
  $("#panel").hidden = true;
});
document.addEventListener("click", function(e){
  var btn = e.target.closest("button"); if (!btn) return;
  var row = btn.closest("tr"); if (!row) return;
  var v = row.dataset.var, input = $(".val", row), sc = scope();
  var panel = $("#panel");

  if (btn.classList.contains("review")) {
    api("/editor/preview", { method: "POST", body: JSON.stringify({ path: dotted(v), value: input.value, mode: sc.mode, brand: sc.brand }) })
      .then(function(r){ return r.json(); }).then(function(p){ showPanel(panel, p, v); });
  } else if (btn.classList.contains("commit")) {
    if (!P.editable) { showMsg(panel, "read-only: write scope required to commit"); return; }
    if (!input.classList.contains("dirty")) { showMsg(panel, "no edits for " + v); return; }
    api("/tokens?channel=" + $("#channel").value, { method: "POST", body: JSON.stringify(commitBody(dotted(v), input.value, sc)) })
      .then(function(r){ return r.json().then(function(j){ return { status: r.status, body: j }; }); })
      .then(function(r){
        if (r.status === 202) { showMsg(panel, "change-request queued: " + r.body.cr.id); return; }
        if (!r.body.ok) { showMsg(panel, "commit failed: " + (r.body.error || "unknown")); return; }
        delete draft[v]; draftCss();
        input.defaultValue = input.value; input.classList.remove("dirty");
        showMsg(panel, "committed " + v + " (" + r.body.changed + " token(s) changed)");
      })
      .catch(function(err){ showMsg(panel, "commit failed: " + err); });
  } else if (btn.classList.contains("rename")) {
    var to = prompt("rename " + dotted(v) + " to (dotted path):", dotted(v));
    if (!to || to === dotted(v)) return;
    api("/editor/preview", { method: "POST", body: JSON.stringify({ rename: { from: dotted(v), to: to } }) })
      .then(function(r){ return r.json(); }).then(function(p){ showPanel(panel, p, v, to); });
  }
});
function showMsg(panel, text){ panel.hidden = false; panel.innerHTML = '<span class="err">' + text + "</span>"; }
function showPanel(panel, p, v, renameTo){
  panel.hidden = false;
  var out = "";
  if (p.errors && p.errors.length) {
    out += '<span class="err">rejected:</span>\\n';
    p.errors.forEach(function(e){
      out += "- " + (e.code === "unknown-ref" ? "unknown reference {" + e.ref + "}" : e.message || e.code) + "\\n";
    });
    if (p.errors[0] && p.errors[0].valid) out += "valid tokens: " + p.errors[0].valid.join(", ") + "\\n";
  }
  if (p.changed) {
    out += p.changed.type === "rename"
      ? "rename " + p.changed.from + " -> " + p.changed.to + "\\n"
      : p.changed.path + " [" + p.changed.scope + "]" + (p.changed.override ? " (new override)" : "") + (p.changed.creates ? " (new token)" : "") + ": " + p.changed.from + " -> " + p.changed.to + "\\n";
  }
  var d = p.diff || {};
  Object.keys(d.added || {}).forEach(function(k){ out += "+ " + k + ": " + d.added[k] + "\\n"; });
  Object.keys(d.removed || {}).forEach(function(k){ out += "- " + k + " (was " + d.removed[k] + ")\\n"; });
  Object.keys(d.changed || {}).forEach(function(k){ out += "~ " + k + ": " + d.changed[k].from + " -> " + d.changed[k].to + "\\n"; });
  if (!Object.keys(d.added || {}).length && !Object.keys(d.removed || {}).length && !Object.keys(d.changed || {}).length) out += "no resolved changes\\n";
  var vr = (p.verdict || {}).bump || "none";
  out += '<span class="badge ' + vr + '">release: ' + vr + "</span>";
  if (p.blocked) out += ' <span class="err">major — removals block the commit unless explicitly confirmed (re-review with confirmed)</span>';
  if (p.impact) {
    var deps = (p.impact.direct || []).concat(p.impact.transitive || []);
    var uniq = deps.filter(function(x, i){ return deps.indexOf(x) === i; });
    out += "\\nimpact: " + (uniq.length ? uniq.join(", ") : "no dependents");
    if (p.impact.deprecated) out += "\\ndeprecated → default edit to {" + p.impact.replacedBy + "} (prefilled)";
  }
  if (p.codemod) {
    out += "\\ncodemod (token-file change is only half the job — hand off to consumers):\\n";
    out += "  token-to-css migrate --from " + dotted(v) + " --to " + renameTo + " --codemod ./app\\n";
    out += "  " + JSON.stringify(p.codemod) + "\\n";
    out += "  (renames cannot merge over the wire — apply via the codemod)";
  }
  panel.innerHTML = out;
  var inp = $('.val[data-var="' + v + '"]');
  if (p.impact && p.impact.deprecated && p.impact.replacedBy && inp && !inp.classList.contains("dirty")) {
    inp.value = "{" + p.impact.replacedBy + "}";
    inp.dispatchEvent(new Event("input"));
  }
}
</script>
</body>
</html>
`;
}
