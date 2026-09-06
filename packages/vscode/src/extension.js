import * as vscode from "vscode";
import { McpClient, resolveMcpCommand } from "./mcpClient.js";
import { buildLanguageIndex, tokenInfo } from "./language.js";
import { hoverAt, completionsAt, diagnosticsFor, quickFixFor } from "./providers.js";
import {
  pathForHover,
  editQuickItems,
  customValueFrom,
  previewRequestBody,
  previewSummary,
  commitBody,
} from "./editing.js";
import { resolveTokensPaths } from "./workspace.js";

const output = vscode.window.createOutputChannel("token-to-css");

/** One language server per matched token file (v12.3 multi-root/glob). */
const servers = new Map(); // tokensPath (absolute, posix) -> {client, index, infoCache}
let diagsCollection = null;
let pendingDiagTimer = null;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("tokenToCss");
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const tokensPath = cfg.get("tokensPath") || "tokens.json";
  return {
    bin: cfg.get("bin") || "token-to-css",
    tokensPath,
    serveUrl: cfg.get("serveUrl") || null,
    workspaceRoot,
    roots,
  };
}

function dispose() {
  for (const [, s] of servers) s.client.dispose();
  servers.clear();
}

/** Boot one MCP child per matched token file. */
async function restart() {
  dispose();
  const { bin, tokensPath, roots } = getConfig();
  if (!roots.length) return;
  const paths = resolveTokensPaths(roots, tokensPath);
  if (paths.length === 0) {
    output.appendLine(`token-to-css: no token files matched "${tokensPath}"`);
    return;
  }
  for (const abs of paths) {
    if (servers.has(abs)) continue;
    const { command, args } = resolveMcpCommand(abs, { bin });
    const client = new McpClient({ command, args, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
    try {
      await client.start();
      const index = await buildLanguageIndex((name, a) => client.callTool(name, a));
      servers.set(abs, { client, index, infoCache: new Map() });
      output.appendLine(
        `token-to-css: ${abs} via ${command} (${client.tools.length} tools, ${Object.keys(index.byPath).length} tokens)`
      );
    } catch (err) {
      output.appendLine(`token-to-css: failed to start for ${abs} — ${err.message}`);
      client.dispose();
    }
  }
  scheduleDiagnostics();
}

function serverForDocument(doc) {
  const file = doc.uri.fsPath.split("\\").join("/");
  if (servers.has(file)) return servers.get(file);
  // Consumer files: pick the first server (single-set workspaces); a future
  // refinement could map by package proximity.
  for (const [, s] of servers) return s;
  return null;
}

function connected() {
  return servers.size > 0;
}

// --- diagnostics (push, debounced) -----------------------------------------

function scheduleDiagnostics() {
  if (pendingDiagTimer) clearTimeout(pendingDiagTimer);
  pendingDiagTimer = setTimeout(runDiagnostics, 400);
}

async function runDiagnostics() {
  if (!connected() || !diagsCollection) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const langs = ["css", "scss", "less", "json"];
  if (!langs.includes(editor.document.languageId)) return;
  const server = serverForDocument(editor.document);
  if (!server) return;
  const text = editor.document.getText();
  const file = editor.document.fileName;
  const isTokensFile = editor.document.languageId === "json";
  try {
    const payload = await server.client.callTool("diagnostics", {
      sources: [{ file, text, kind: isTokensFile ? "tokens" : "consumer" }],
    });
    const ds = diagnosticsFor(
      text,
      file,
      payload.diagnostics.filter((d) => d.file === file),
      server.index
    );
    diagsCollection.set(editor.document.uri, ds.map(toDiagnostic));
  } catch (err) {
    output.appendLine(`diagnostics failed: ${err.message}`);
  }
}

function toDiagnostic(d) {
  const start = new vscode.Position(d.range.start.line, d.range.start.character);
  const end = new vscode.Position(d.range.end.line, d.range.end.character);
  const diag = new vscode.Diagnostic(
    new vscode.Range(start, end),
    d.message,
    d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
  );
  diag.code = d.code;
  diag.source = "token-to-css";
  // quickFixFor reads these off the diagnostic.
  diag.variable = d.variable;
  diag.path = d.path;
  diag.exact = d.exact;
  diag.replacedBy = d.replacedBy;
  diag.replacement = d.replacement;
  return diag;
}

function toRange(r) {
  return new vscode.Range(
    new vscode.Position(r.start.line, r.start.character),
    new vscode.Position(r.end.line, r.end.character)
  );
}

// --- v12.3: true inline editing ---------------------------------------------
// hover → QuickPick → POST /editor/preview (diff-before-commit) → governed
// POST /tokens — the same pipeline as the web editor, without leaving VS Code.

async function editTokenAt(document, position) {
  const { serveUrl } = getConfig();
  const server = serverForDocument(document);
  if (!server) {
    output.appendLine("token-to-css: language server not running");
    return;
  }
  if (!serveUrl) {
    output.appendLine(
      "token-to-css: set tokenToCss.serveUrl (e.g. http://localhost:4173) to commit inline edits through a running serve"
    );
    output.show(true);
    return;
  }
  const text = document.getText();
  const hover = hoverAt(text, document.offsetAt(position), server.index);
  const path = pathForHover(hover);
  if (!path) {
    vscode.window.showInformationMessage("token-to-css: put the cursor on a token (var(--x), {ref}, or its key)");
    return;
  }
  const info = await tokenInfo(
    (n, a) => server.client.callTool(n, a),
    server.infoCache,
    path
  );
  if (!info) {
    vscode.window.showInformationMessage(`token-to-css: unknown token ${path}`);
    return;
  }

  const { items, placeholder } = editQuickItems(info);
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
  });
  let value;
  if (!picked) return;
  if (picked.pick) {
    value = picked.value;
  } else {
    value = customValueFrom(await vscode.window.showInputBox({ prompt: picked.description, value: info.value }));
    if (value === "" || value == null) return;
  }

  const base = serveUrl.replace(/\/$/, "");
  const body = previewRequestBody(path, value);
  let preview;
  try {
    const res = await fetch(`${base}/editor/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    preview = await res.json();
  } catch (err) {
    vscode.window.showErrorMessage(`token-to-css: preview failed — ${err.message}`);
    return;
  }
  const summary = previewSummary(preview);
  const choice = await vscode.window.showQuickPick(
    [...summary.map((l) => ({ label: l, pick: false })), { label: "$(check) Commit this change", pick: true }],
    { placeHolder: `Preview: ${path} → ${value}` }
  );
  if (!choice || !choice.pick) return;

  try {
    const res = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(commitBody(path, value)),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 202) {
      vscode.window.showInformationMessage(`token-to-css: change-request queued (${json.cr && json.cr.id})`);
    } else if (json.ok) {
      vscode.window.showInformationMessage(`token-to-css: committed ${path} → ${value}`);
    } else {
      vscode.window.showErrorMessage(`token-to-css: commit failed — ${json.error || res.status}`);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`token-to-css: commit failed — ${err.message}`);
  }
}

export function activate(context) {
  diagsCollection = vscode.languages.createDiagnosticCollection("token-to-css");

  // Hover: var(--x), {ref}, and token keys — resolved value, swatch hex,
  // deprecation. Thin over the MCP `token_info` tool.
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(["css", "scss", "less", "json"], {
      async provideHover(document, position) {
        if (!connected()) return null;
        const server = serverForDocument(document);
        if (!server) return null;
        const text = document.getText();
        const h = hoverAt(text, document.offsetAt(position), server.index);
        if (!h) return null;
        const md = new vscode.MarkdownString();
        if (h.suggestion) {
          md.appendMarkdown(h.markdown);
          md.appendMarkdown(`\n\n[$("edit") Edit token](command:token-to-css.editToken)`);
          md.isTrusted = true;
          return new vscode.Hover(md);
        }
        const info = await tokenInfo(
          (n, a) => server.client.callTool(n, a),
          server.infoCache,
          h.path
        );
        if (!info) return null;
        md.appendMarkdown(`**${info.path}**\n\n`);
        md.appendMarkdown(`\`${info.value}\`\n\n`);
        if (info.variable) md.appendCodeblock(`var(${info.variable})`, "css");
        if (info.color && info.color.hex) md.appendCodeblock(info.color.hex, "css");
        if (info.deprecated) {
          md.appendMarkdown(
            `⚠️ deprecated${info.replacedBy ? ` — use \`${info.replacedBy}\`` : ""}`
          );
        }
        md.appendMarkdown(`\n\n[$("edit") Edit token](command:token-to-css.editToken)`);
        md.isTrusted = true;
        return new vscode.Hover(md);
      },
    })
  );

  // Completion: --names in CSS/SCSS, {dotted} refs in token files. Includes
  // mode/brand-scoped overrides (they are separate flattened paths) and
  // deprecation tags.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      ["css", "scss", "less", "json"],
      {
        async provideCompletionItems(document, position) {
          if (!connected()) return null;
          const server = serverForDocument(document);
          if (!server) return null;
          const offset = document.offsetAt(position);
          const result = completionsAt(document.getText(), offset, server.index);
          if (result.kind === null) return null;
          return result.items.map((item) => {
            const it = new vscode.CompletionItem(item.label, vscode.CompletionItemKind.Variable);
            it.detail = item.detail;
            it.range = toRange({
              start: document.positionAt(result.replaceStart),
              end: document.positionAt(result.replaceEnd),
            });
            if (item.deprecated) it.tags = [vscode.CompletionItemTag.Deprecated];
            if (result.kind === "css") it.insertText = `var(${item.variable})`;
            else it.insertText = `{${item.path}}`;
            return it;
          });
        },
      },
      "-",
      "{"
    )
  );

  // Quick-fix: adopt --fix semantics for a hardcoded literal; v12.3 adds the
  // deprecated-in-use migration fix (replacedBy swap).
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(["css", "scss", "less", "json"], {
      provideCodeActions(document, _range, ctx) {
        const actions = [];
        for (const diag of ctx.diagnostics) {
          const fix = quickFixFor({
            code: diag.code,
            variable: diag.variable,
            replacedBy: diag.replacedBy,
            replacement: diag.replacement,
            range: diag.range,
          });
          if (!fix) continue;
          const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
          action.diagnostics = [diag];
          action.edit = new vscode.WorkspaceEdit();
          action.edit.replace(document.uri, toRange(fix.edit.range), fix.edit.replacement);
          actions.push(action);
        }
        return actions;
      },
    })
  );

  // v12.3: inline token editing from the editor — hover → QuickPick →
  // /editor/preview → governed commit (requires tokenToCss.serveUrl).
  context.subscriptions.push(
    vscode.commands.registerCommand("token-to-css.editToken", async (...args) => {
      const document = args[0] && args[0].document ? args[0] : vscode.window.activeTextEditor?.document;
      const position = args[0] && args[0].position ? args[0].position : vscode.window.activeTextEditor?.selection?.active;
      if (!document || !position) return;
      await editTokenAt(document, position);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("token-to-css.restart", restart)
  );

  // Inline editing / live preview: deep-link to the v10.5 editor on a running
  // serve (same diff-before-commit pipeline, governance applies), and a
  // webview running the kit preview over the /events SSE stream.
  context.subscriptions.push(
    vscode.commands.registerCommand("token-to-css.openEditor", async () => {
      const { serveUrl } = getConfig();
      if (!serveUrl) {
        output.appendLine(
          "token-to-css: set tokenToCss.serveUrl (e.g. http://localhost:4173) to open the visual editor"
        );
        output.show(true);
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(`${serveUrl.replace(/\/$/, "")}/editor`));
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("token-to-css.preview", async () => {
      const { serveUrl } = getConfig();
      if (!serveUrl) {
        output.appendLine(
          "token-to-css: set tokenToCss.serveUrl to open the live preview"
        );
        output.show(true);
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "token-to-css.preview",
        "token-to-css — live preview",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = `<!doctype html>
<html><body style="margin:0">
<iframe src="${serveUrl.replace(/\/$/, "")}/" style="border:0;width:100vw;height:100vh"></iframe>
</body></html>`;
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (connected() && ["css", "scss", "less", "json"].includes(e.document.languageId)) {
        scheduleDiagnostics();
      }
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && ["css", "scss", "less", "json"].includes(editor.document.languageId)) {
        scheduleDiagnostics();
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const { roots, tokensPath } = getConfig();
      const paths = resolveTokensPaths(roots, tokensPath);
      if (paths.includes(doc.fileName.split("\\").join("/"))) restart();
    })
  );

  restart();
}

export function deactivate() {
  dispose();
  if (pendingDiagTimer) clearTimeout(pendingDiagTimer);
}
