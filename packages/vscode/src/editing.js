/**
 * Pure inline-edit helpers for the v12.3 "true inline editing" flow:
 *
 *   hover → QuickPick (this file) → `/editor/preview` (diff-before-commit,
 *   v10.5) → governed `POST /tokens` commit.
 *
 * Deliberately vscode-free and network-free — extension.js maps these onto
 * the QuickPick/WorkspaceEdit APIs and the running serve's HTTP endpoints,
 * exactly like the web editor does, so governance applies end to end.
 */

/** Resolve the dotted token path for a hover target. */
export function pathForHover(hover) {
  if (!hover) return null;
  if (hover.kind === "suggestion") return hover.path || null;
  return hover.path || null;
}

const COLOR_LIKE = /^(#|rgba?\(|oklch|oklab|lab|lch)/i;
const DIMENSION = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i;
const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * QuickPick items for a token's current value. Colors get the +/-10%
 * lightness presets plus a free-text "custom value" item; dimensions get
 * ±10% steps; anything else starts as free text. The returned
 * `{ items, placeholder, initialPick }` is rendered 1:1 by extension.js.
 */
export function editQuickItems(token) {
  const info = token || {};
  const value = info.value != null ? String(info.value) : "";
  const kind = info.color && info.color.hex ? "color" : DIMENSION.test(value.trim()) ? "dimension" : "text";
  const items = [];
  const label = kind === "color" ? `${info.color.hex}` : value;
  if (kind === "color") {
    const hex = info.color.hex;
    const rgb = hexToRgb(hex);
    for (const pct of [10, -10]) {
      const next = rgb ? rgbToHex(shiftLightness(rgb, pct)) : hex;
      items.push({
        label: `${pct > 0 ? "▲" : "▼"} ${next}`,
        description: `${pct > 0 ? "lighten" : "darken"} 10%`,
        value: next,
        pick: true,
      });
    }
    items.push({ label: "$(symbol-color) Custom value…", description: label, value: null, pick: false });
  } else if (kind === "dimension") {
    const m = DIMENSION.exec(value.trim());
    for (const pct of [10, -10]) {
      const n = Math.round(parseFloat(m[1]) * (pct > 0 ? 1.1 : 1 / 1.1) * 1000) / 1000;
      items.push({
        label: `${pct > 0 ? "▲" : "▼"} ${n}${m[2]}`,
        description: `${pct > 0 ? "grow" : "shrink"} 10%`,
        value: `${n}${m[2]}`,
        pick: true,
      });
    }
    items.push({ label: "$(pencil) Custom value…", description: value, value: null, pick: false });
  } else {
    items.push({ label: "$(pencil) Custom value…", description: value, value: null, pick: false });
  }
  return { kind, items, placeholder: `New value for ${info.path || "token"} (current: ${label})` };
}

/** Parse the free-text branch of a QuickPick (`pick: false`) into a value. */
export function customValueFrom(input) {
  return input == null ? "" : String(input).trim();
}

/**
 * Build the `/editor/preview` request body for a value edit — the exact edit
 * the v10.5 web editor would POST. `scope` is `{ mode?, brand? }`.
 */
export function previewRequestBody(path, value, scope = {}) {
  return { path, value, mode: scope.mode || undefined, brand: scope.brand || undefined };
}

/**
 * Compact the previewEdit payload into the lines the extension shows before a
 * commit: the change, resolved diff, semver verdict, blockers, and impact.
 */
export function previewSummary(preview) {
  const out = [];
  const p = preview || {};
  if (p.errors && p.errors.length) {
    for (const e of p.errors) {
      out.push(`rejected: ${e.code === "unknown-ref" ? `unknown reference {${e.ref}}` : e.message || e.code}`);
    }
    if (p.errors[0] && p.errors[0].valid) out.push(`valid tokens: ${p.errors[0].valid.join(", ")}`);
    return out;
  }
  const c = p.changed;
  if (c) {
    out.push(
      c.type === "rename"
        ? `rename ${c.from} → ${c.to}`
        : `${c.path} [${c.scope}]${c.override ? " (new override)" : ""}${c.creates ? " (new token)" : ""}: ${c.from} → ${c.to}`
    );
  }
  const d = p.diff || {};
  let diffCount = 0;
  for (const k of Object.keys(d.added || {})) { out.push(`+ ${k}: ${d.added[k]}`); diffCount++; }
  for (const k of Object.keys(d.removed || {})) { out.push(`- ${k} (was ${d.removed[k]})`); diffCount++; }
  for (const k of Object.keys(d.changed || {})) {
    out.push(`~ ${k}: ${d.changed[k].from} → ${d.changed[k].to}`);
    diffCount++;
  }
  if (diffCount === 0) out.push("no resolved changes");
  const bump = (p.verdict || {}).bump || "none";
  out.push(`release: ${bump}`);
  if (p.blocked) out.push("major — removals block the commit unless explicitly confirmed");
  if (p.impact) {
    const deps = [...new Set([...(p.impact.direct || []), ...(p.impact.transitive || [])])];
    out.push(`impact: ${deps.length ? deps.join(", ") : "no dependents"}`);
  }
  return out;
}

/**
 * The `POST /tokens` body for a committed inline edit — a scoped subtree,
 * byte-for-byte the shape the web editor's `commitBody` builds.
 */
export function commitBody(path, value, scope = {}) {
  const parts = String(path).split(".");
  const leaf = {};
  let cur = leaf;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  if (scope.mode) return { modes: { [scope.mode]: leaf } };
  if (scope.brand) return { brands: { [scope.brand]: leaf } };
  return leaf;
}

function hexToRgb(hex) {
  const m = HEX6.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[0].slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function shiftLightness({ r, g, b }, pct) {
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (pct > 0 ? (255 - c) * (pct / 100) : c * (pct / 100)))));
  return { r: f(r), g: f(g), b: f(b) };
}

function rgbToHex({ r, g, b }) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
