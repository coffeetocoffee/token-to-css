/**
 * Pure language providers for the token-to-css VS Code extension.
 *
 * These functions contain ALL the language intelligence of the extension and
 * are deliberately free of any `vscode` import so they run in plain Node
 * (unit tests, other editors). The extension.js shell maps their output onto
 * VS Code's Hover/CompletionItem/Diagnostic/CodeAction APIs.
 */

/** Find `{dotted.ref}` occurrences in text. Returns [{ref, index, length}]. */
export function findRefs(text) {
  const out = [];
  const re = /\{([\w.:-]+)\}/g;
  let m;
  while ((m = re.exec(text))) {
    if (/^\d+$/.test(m[1])) continue; // {0} placeholders aren't refs
    out.push({ ref: m[1], index: m.index, length: m[0].length });
  }
  return out;
}

/** Find `var(--x)` occurrences. Returns [{name, index, length}]. */
export function findVarUses(text) {
  const out = [];
  const re = /var\(\s*(--[\w-]+)\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ name: m[1], index: m.index, length: m[0].length });
  }
  return out;
}

/** Convert a 0-based character offset to a 1-based {line, column}. */
export function offsetToPosition(text, index) {
  const line = text.slice(0, index).split("\n").length;
  const column = index - text.lastIndexOf("\n", index - 1);
  return { line, column };
}

/**
 * Hover data for an offset in a CSS/SCSS or token-JSON file.
 * `index` maps dotted path -> info (MCP `token_info` payload).
 * Returns null when nothing token-related is under the cursor.
 */
export function hoverAt(text, offset, index) {
  for (const { name, index: start } of findVarUses(text)) {
    const nameStart = start + text.slice(start).indexOf(name);
    if (offset >= nameStart && offset < nameStart + name.length) {
      const path = varNameToPath(name, index.byVariable);
      return path ? buildHover(index.byPath[path], path) : null;
    }
  }
  for (const { ref, index: start } of findRefs(text)) {
    const refStart = start + 1;
    if (offset >= refStart && offset < refStart + ref.length) {
      return index.byPath[ref] ? buildHover(index.byPath[ref], ref) : null;
    }
  }
  // A bare hex literal matching a token (v9 lintConsumer suggestion).
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  let m;
  while ((m = hexRe.exec(text))) {
    if (offset >= m.index && offset < m.index + m[0].length) {
      const match = index.byHex && index.byHex[m[0].toLowerCase()];
      if (match) {
        return {
          kind: "suggestion",
          path: match.path,
          value: match.value,
          variable: match.variable,
          markdown: `**${match.path}** \`${match.value}\`\n\nHardcoded — use \`var(${match.variable})\` instead.`,
        };
      }
    }
  }
  return null;
}

function varNameToPath(name, byVariable) {
  if (byVariable[name]) return byVariable[name].path;
  return name.replace(/^--/, "").replace(/-/g, ".") || null;
}

function buildHover(info, path) {
  if (!info) return null;
  const lines = [`**${path}**`];
  if (info.value != null) lines.push(`\`${info.value}\``);
  if (info.color && info.color.hex) lines.push(`swatch: \`${info.color.hex}\``);
  if (info.variable) lines.push(`\`${info.variable}\``);
  if (info.deprecated) {
    lines.push(`⚠️ deprecated${info.replacedBy ? ` — use \`${info.replacedBy}\`` : ""}`);
  }
  if (info.dependents && info.dependents.length > 0) {
    lines.push(`used by: ${info.dependents.join(", ")}`);
  }
  return { ...info, path, markdown: lines.join("  \n") };
}

/**
 * Completions at an offset. Returns `{ kind: "css" | "ref" | null, items }`.
 * In CSS context the replace-range covers the `--name` inside var(…); in ref
 * context it covers the dotted path inside {…}.
 */
export function completionsAt(text, offset, index) {
  // Inside var( ... ) — complete --names.
  const before = text.slice(0, offset);
  const varOpen = before.lastIndexOf("var(");
  if (varOpen !== -1) {
    const since = before.slice(varOpen + 4);
    if (!/['"{]/.test(since) && !since.includes(")")) {
      const typed = /(--[\w-]*)$/.exec(since);
      const prefix = typed ? typed[1] : "";
      const start = varOpen + 4 + since.length - prefix.length;
      return {
        kind: "css",
        prefix,
        replaceStart: start,
        replaceEnd: offset,
        items: filterCompletions(index.completions, prefix.replace(/^--/, ""), "css"),
      };
    }
  }
  // Inside { ... } — complete {dotted} refs (token files).
  const braceOpen = before.lastIndexOf("{");
  if (braceOpen !== -1) {
    const since = before.slice(braceOpen + 1);
    if (!since.includes("\n") && !since.includes("}")) {
      const typed = /([\w.:-]*)$/.exec(since);
      const prefix = typed ? typed[1] : "";
      const start = braceOpen + 1 + since.length - prefix.length;
      return {
        kind: "ref",
        prefix,
        replaceStart: start,
        replaceEnd: offset,
        items: filterCompletions(index.completions, prefix, "ref"),
      };
    }
  }
  return { kind: null, items: [] };
}

function filterCompletions(items, prefix, kind) {
  const p = String(prefix || "").toLowerCase();
  return items
    .filter((c) => {
      if (kind === "css") return c.variable.toLowerCase().includes(p);
      return c.path.toLowerCase().includes(p) || `{${c.path}}`.toLowerCase().includes(p);
    })
    .map((c) => ({
      label: kind === "ref" ? `{${c.path}}` : c.variable,
      path: c.path,
      value: c.value,
      variable: c.variable,
      deprecated: Boolean(c.deprecated),
      replacedBy: c.replacedBy || null,
      detail: c.detail,
    }));
}

/**
 * Diagnostics for one document (already the MCP `diagnostics` payload for that
 * file, plus unknown-ref checks done client-side from the language index).
 * Returns VS Code-shaped ranges (0-based line/char) for the extension shell.
 */
export function diagnosticsFor(text, file, diags, index) {
  const out = [];
  for (const d of diags) {
    out.push({
      code: d.code,
      message: d.message,
      severity: d.severity,
      // MCP diagnostics are 1-based; VS Code ranges are 0-based.
      range: {
        start: { line: d.line - 1, character: d.column - 1 },
        end: { line: d.line - 1, character: d.column - 1 + d.length },
      },
      variable: d.variable,
      path: d.path,
      exact: d.exact,
    });
  }
  for (const { ref, index: start, length } of findRefs(text)) {
    if (!index.byPath[ref]) {
      const pos = offsetToPosition(text, start + 1);
      out.push({
        code: "unknown-ref",
        message: `unknown token reference {${ref}}`,
        severity: "error",
        range: {
          start: { line: pos.line - 1, character: pos.column - 1 },
          end: {
            line: pos.line - 1,
            character: pos.column - 1 + ref.length,
          },
        },
      });
    }
  }
  return out;
}

/** The quick-fix (CodeAction) payload for one diagnostic. */
export function quickFixFor(diagnostic) {
  if (diagnostic.code !== "hardcoded-value" || !diagnostic.variable) return null;
  return {
    title: `Use ${diagnostic.variable}`,
    kind: "quickfix",
    edit: {
      replacement: `var(${diagnostic.variable})`,
      range: diagnostic.range,
    },
  };
}
