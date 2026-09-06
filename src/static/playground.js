// Static playground client (v12.2). Loaded as a module by the static site;
// the compiler comes from the page's import map (`@token-to-css/core` pinned
// to a CDN build of the current major). No server is required for the preview
// and editor; an optional serve URL receives proposals through its governed
// write scope (with `serve --cors` for cross-origin use, e.g. GitHub Pages).

import {
  normalizeW3C,
  resolveReferences,
  convert,
  diffTokens,
  classifyRelease,
  parseColor,
} from "@token-to-css/core";

const cfg = window.TTC_STATIC_CONFIG || {};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

let tree = null; // the working (normalized) token tree
let paths = new Set(); // valid dotted paths, for {ref} validation
let flat = {}; // dotted path -> resolved value (sorted at render)

function walkPaths(node, prefix, into) {
  for (const [key, value] of Object.entries(node || {})) {
    const p = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      walkPaths(value, p, into);
    } else if (value !== null && value !== undefined) {
      into.add(p.join("."));
    }
  }
}

function flattenResolved(node, prefix, into) {
  for (const [key, value] of Object.entries(node || {})) {
    const p = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenResolved(value, p, into);
    } else if (value !== null && value !== undefined) {
      into[p.join(".")] = String(value);
    }
  }
}

function setByPath(node, segments, value) {
  let cur = node;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!cur[segments[i]] || typeof cur[segments[i]] !== "object") {
      cur[segments[i]] = {};
    }
    cur = cur[segments[i]];
  }
  cur[segments[segments.length - 1]] = value;
}

function buildSubtree(segments, value) {
  const out = {};
  let cur = out;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = cur[segments[i]] = {};
  }
  cur[segments[segments.length - 1]] = value;
  return out;
}

function status(message, isError = false) {
  const el = $("status");
  el.textContent = message || "";
  el.classList.toggle("err", Boolean(message) && isError);
  el.classList.toggle("ok", Boolean(message) && !isError);
}

function collect() {
  paths = new Set();
  flat = {};
  walkPaths(tree, [], paths);
  const resolved = resolveReferences(structuredClone(tree), { reduce: true });
  flattenResolved(resolved, [], flat);
}

function render() {
  $("ttc-css").textContent = convert(structuredClone(tree), { format: "css" });
  const rows = Object.keys(flat)
    .sort()
    .map((path) => {
      const value = flat[path];
      const swatch = parseColor(value)
        ? `<span class="sw" style="background:${esc(value)}"></span>`
        : `<span class="sw none"></span>`;
      return `<tr>
  <td><code>${esc(path)}</code></td>
  <td><code>${esc(value)}</code></td>
  <td>${swatch}</td>
  <td><button data-edit="${esc(path)}" data-value="${esc(value)}">edit</button></td>
</tr>`;
    })
    .join("");
  $("rows").innerHTML = rows;
  $("count").textContent = `${Object.keys(flat).length} tokens`;
}

function validateValue(value) {
  const v = String(value);
  if (!v.trim()) return "value is required";
  for (const m of v.matchAll(/\{([^}]+)\}/g)) {
    if (!paths.has(m[1])) return `unknown reference {${m[1]}}`;
  }
  if (!v.includes("{")) {
    const looksColor = /^#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(/i.test(v.trim());
    if (looksColor && !parseColor(v.trim())) return `not a parseable color: ${v.trim()}`;
  }
  return null;
}

function serveConfig() {
  const serveUrl = ($("serveUrl").value || cfg.serveUrl || "").trim();
  const token = ($("token").value || cfg.token || "").trim();
  return { serveUrl, token };
}

async function commit(path, value) {
  const segments = path.split(".");
  const before = structuredClone(tree);
  const after = structuredClone(tree);
  setByPath(after, segments, value);
  const diff = diffTokens(before, after);
  const verdict = classifyRelease(before, after);
  const summary = `+${Object.keys(diff.added).length} -${Object.keys(diff.removed).length} ~${Object.keys(diff.changed).length} (${verdict.bump})`;

  if (verdict.bump === "major" && !confirm("This change removes tokens (major). Apply anyway?")) {
    status("cancelled", true);
    return;
  }

  const { serveUrl, token } = serveConfig();
  if (serveUrl) {
    try {
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${serveUrl.replace(/\/$/, "")}/tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildSubtree(segments, value)),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 202) {
        status(`change-request ${json.cr ? json.cr.id : ""} queued on the server — pending review`);
      } else if (!res.ok) {
        status(`server rejected the proposal: ${res.status} ${json.error || ""}`.trim(), true);
        return;
      } else {
        status(`committed through the server write scope (${summary})`);
      }
    } catch (e) {
      status(`could not reach the server: ${e.message}`, true);
      return;
    }
  } else {
    status(`applied locally (${summary}) — set a serve URL to propose through governance`);
  }

  tree = after;
  collect();
  render();
}

function download() {
  const blob = new Blob([JSON.stringify(tree, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tokens.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function load() {
  let parsed;
  try {
    parsed = JSON.parse($("tokens").value);
  } catch (e) {
    status(`invalid JSON: ${e.message}`, true);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    status("a token object is required", true);
    return;
  }
  try {
    tree = normalizeW3C(parsed);
  } catch (e) {
    status(`could not normalize tokens: ${e.message}`, true);
    return;
  }
  collect();
  render();
  $("app").hidden = false;
  status("loaded — edit any token below");
}

$("load").addEventListener("click", load);
$("download").addEventListener("click", download);
$("rows").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-edit]");
  if (!btn) return;
  const path = btn.getAttribute("data-edit");
  const current = btn.getAttribute("data-value");
  const next = prompt(`New value for ${path}`, current);
  if (next === null || next === current) return;
  const problem = validateValue(next);
  if (problem) {
    status(problem, true);
    return;
  }
  await commit(path, next);
});
if (cfg.serveUrl) $("serveUrl").value = cfg.serveUrl;
if (cfg.token) $("token").value = cfg.token;
