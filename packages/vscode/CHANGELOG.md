# Changelog — token-to-css VS Code extension

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [12.1.0]

### Added — Marketplace release

- Packaged and published to the VS Code Marketplace (+ Open VSX mirror) as a
  Visual Studio Code extension. Install by searching **"token-to-css"** in the
  Extensions view — no repo checkout required, only the `token-to-css` CLI
  (v12.0.0+) on `PATH`.
- CI workflow (`vscode.yml`): builds the `.vsix` on every push and, on a
  `v*` tag, publishes to the marketplace and Open VSX.
- `.vscodeignore` keeps the VSIX lean (tests/fixtures/cruft excluded).
- Added `repository`, `galleryBanner`, and `keywords` metadata for the
  marketplace listing.

## [12.0.0] — initial release

First published as part of the v12.0 release (this changelog extracted at
12.1.0):

- **Thin client over `token-to-css mcp`** — spawns the installed CLI and
  speaks MCP over stdio; no bundled compiler.
- **Hover + swatch** — `var(--color-primary)`, `{token}` refs, and raw hex
  literals that match a token resolve to value + swatch + variable; deprecated
  tokens show their `replacedBy` migration path.
- **Completion** — `--*` names in CSS/SCSS and `{dotted}` refs in token
  files (mode/brand-scoped overrides included; deprecated entries tagged).
- **Diagnostics + quick-fix** — the v9 consumer lint as squiggles with a
  `use var(--token)` quick-fix (idempotent `adopt --fix` semantics).
- **Commands** — restart the language server, open the visual editor
  (`token-to-css serve`), and a live theme preview webview over `/events`.