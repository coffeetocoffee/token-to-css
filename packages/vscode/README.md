# token-to-css — VS Code extension

Live design tokens inside the editor: hover, completion, and adoption
diagnostics for `tokens.json`-driven CSS.

The extension is a **thin client over `token-to-css mcp`** — it spawns your
installed CLI as a child process and speaks the Model Context Protocol
(newline-delimited JSON-RPC 2.0) over stdio. No compiler code is bundled, and
the language brain is the same MCP server your AI agents and CI already use
(v9), extended with three tools (`token_info`, `completions`, `diagnostics`).

## Features

- **Hover + swatch** — hovering `var(--color-primary)`, a `{color.primary}`
  ref, or a raw hex that matches a token shows the resolved value, a color
  swatch, the CSS variable, and the deprecation path (`replacedBy`) when the
  token is deprecated.
- **Completion** — `--*` variable names in CSS/SCSS (inside `var(`), and
  `{dotted}` refs in token files. Deprecated tokens are tagged and sorted last.
- **Diagnostics + quick-fix** — hardcoded color/dimension literals that match
  (or nearly match, via OKLCH distance) a known token become squiggles with a
  `use var(--token)` quick-fix (the `adopt --fix` semantics applied to the
  single squiggle — idempotent).
- **Commands** — restart the language server, open the visual token editor,
  and open a live theme preview webview (iframes a running
  `token-to-css serve` playground over `/events`).

## Requirements

- The `token-to-css` CLI (v12.0.0+) on `PATH` — `npm i -g token-to-css`.
- A `tokens.json` in the workspace (or set `tokenToCss.tokensPath`).

## Configuration

```jsonc
{
  "tokenToCss.tokensPath": "tokens.json",       // relative to workspace root
  "tokenToCss.bin": "token-to-css",             // CLI binary (default: PATH)
  "tokenToCss.serveUrl": "http://localhost:4173" // optional: editor + preview
}
```

## Development

The language logic (`src/providers.js`, `src/language.js`) and the MCP client
(`src/mcpClient.js`) are pure Node — no `vscode` import — and are covered by
`packages/vscode/test/extension.test.js`, including an end-to-end run against
the real CLI over stdio:

```
node --test packages/vscode/test
```

Only `src/extension.js` touches the VS Code API.

## Why a thin client?

The roadmap (v12.0) is explicit: *the extension boots `token-to-css mcp` as a
child process and speaks the existing MCP tools — no new protocol, no
bundling the compiler.* Adding editor features means adding MCP tools, which
every MCP client (AI coding agents included) benefits from immediately.
