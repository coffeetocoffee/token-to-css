import * as vscode from "vscode";
import { resolve as resolvePath } from "node:path";
import { McpClient, resolveMcpCommand } from "./mcpClient.js";
import { buildLanguageIndex, tokenInfo } from "./language.js";
import { hoverAt, completionsAt, diagnosticsFor, quickFixFor } from "./providers.js";

const output = vscode.window.createOutputChannel("token-to-css");
let client = null;
let index = null;
const infoCache = new Map();
let diagsCollection = null;
let pendingDiagTimer = null;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("tokenToCss");
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const tokensPath = cfg.get("tokensPath") || "tokens.json";
  return {
    bin: cfg.get("bin") || "token-to-css",
    tokensPath,
    serveUrl: cfg.get("serveUrl") || null,
    workspaceRoot,
  };
}

function dispose() {
  if (client) {
    client.dispose();
    client = null;
  }
  index = null;
  infoCache.clear();
}

/** Boot `token-to-css mcp <tokens>` (the CLI on PATH) and cache the index. */
async function restart() {
  dispose();
  const { bin, tokensPath, workspaceRoot } = getConfig();
  if (!workspaceRoot) return;
  const absTokens = resolvePath(workspaceRoot, tokensPath);
  const { command, args } = resolveMcpCommand(absTokens, { bin });
  client = new McpClient({ command, args, cwd: workspaceRoot });
  try {
    await client.start();
    index = await buildLanguageIndex((name, a) => client.callTool(name, a));
    output.appendLine(
      `token-to-css: connected via ${command} (${client.tools.length} tools, ${Object.keys(index.byPath).length} tokens)`
    );
    scheduleDiagnostics();
  } catch (err) {
    output.appendLine(`token-to-css: failed to start — ${err.message}`);
  }
}

function connected() {
  return Boolean(client && index);
}

// --- diagnostics (push, debounced) ---------------------------------------

function scheduleDiagnostics() {
  if (pendingDiagTimer) clearTimeout(pendingDiagTimer);
  pendingDiagTimer = setTimeout(runDiagnostics, 400);
}

async function runDiagnostics() {
  if (!connected() || !diagsCollection) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || !["css", "scss", "less"].includes(editor.document.languageId)) return;
  const text = editor.document.getText();
  const file = editor.document.fileName;
  try {
    const payload = await client.callTool("diagnostics", {
      sources: [{ file, text }],
    });
    const ds = diagnosticsFor(
      text,
      file,
      payload.diagnostics.filter((d) => d.file === file),
      index
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
  return diag;
}

function toRange(r) {
  return new vscode.Range(
    new vscode.Position(r.start.line, r.start.character),
    new vscode.Position(r.end.line, r.end.character)
  );
}

export function activate(context) {
  diagsCollection = vscode.languages.createDiagnosticCollection("token-to-css");

  // Hover: var(--x), {ref}, and token keys — resolved value, swatch hex,
  // deprecation. Thin over the MCP `token_info` tool.
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(["css", "scss", "less", "json"], {
      async provideHover(document, position) {
        if (!connected()) return null;
        const text = document.getText();
        const h = hoverAt(text, document.offsetAt(position), index);
        if (!h) return null;
        const md = new vscode.MarkdownString();
        if (h.suggestion) {
          md.appendMarkdown(h.markdown);
          return new vscode.Hover(md);
        }
        const info = await tokenInfo((n, a) => client.callTool(n, a), infoCache, h.path);
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
          const offset = document.offsetAt(position);
          const result = completionsAt(document.getText(), offset, index);
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

  // Quick-fix: adopt --fix semantics for a single squiggle.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(["css", "scss", "less"], {
      provideCodeActions(document, _range, ctx) {
        const actions = [];
        for (const diag of ctx.diagnostics) {
          const fix = quickFixFor({
            code: diag.code,
            variable: diag.variable,
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
      if (connected() && ["css", "scss", "less"].includes(e.document.languageId)) {
        scheduleDiagnostics();
      }
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && ["css", "scss", "less"].includes(editor.document.languageId)) {
        scheduleDiagnostics();
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const { workspaceRoot, tokensPath } = getConfig();
      if (workspaceRoot && doc.fileName === resolvePath(workspaceRoot, tokensPath)) {
        restart();
      }
    })
  );

  restart();
}

export function deactivate() {
  dispose();
  if (pendingDiagTimer) clearTimeout(pendingDiagTimer);
}
