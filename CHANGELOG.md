# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.0.1] - 2026-09-03

### Changed
- Marked the `sync` command and its library surface (`applyReversedIntoSource`,
  `computeDrift`, `canSetPath`) as **experimental**. `sync` may change in a minor
  release without a major bump while it bakes; it is not covered by the
  major-version stability guarantee. The CLI now prints an experimental notice
  when `sync` runs.


## [4.0.0] - 2026-09-03

### Added
- **`sync`**: bidirectional watch mode. Generates the kit/artifacts once, then
  watches both the source tokens file (forward: regenerate on edit) and the
  emitted artifacts (reverse: an external edit to the CSS/`tokens.ts` is parsed
  back via `reverse()` and folded into `tokens.json`, then everything is
  re-emitted). Source of truth stays `tokens.json`. CLI:
  `token-to-css sync <input.json> [options]`.
- **`applyReversedIntoSource(source, reversed)`**: pure helper that folds a
  reversed artifact back into the source tree, applying only unambiguous
  (non-colliding) names; colliding kebab-case names are reported in `skipped`
  and left untouched (keeps the round-trip idempotent and lossless where
  possible).
- **`computeDrift(source, reversed)`**: returns per-group (`base`, `modes.*`,
  `brands.*`) added/changed token names for drift reporting.
- **Idempotent writes**: `generate` now skips writing a file when its content is
  unchanged, so `sync` watch loops never re-trigger on their own output.

### Changed
- `convert` output (css/barefoot) now emits `[data-brand="x"]` blocks
  alongside `[data-mode="x"]` (behavioral change flagged by the major bump in
  v3.0; retained here under the v4.0 major).
- *Why major:* introduces a persistent `sync` process and the reverse-merge
  contract; `reverse` is best-effort (kebab collisions resolve to the leaf and
  drop the nested branch), so `sync` scopes reverse-sync to non-colliding names.


## [3.0.0] - 2026-09-03

### Added
- **`reverse`**: CSS/SCSS → token tree (best-effort round-trip). Folds `:root`
  into the base, `[data-mode="x"]` into `modes.x`, `[data-brand="x"]` into
  `brands.x`, and maps barefoot `--bf-*` vars back to token paths. CLI:
  `token-to-css reverse <file.css> -o tokens.json`.
- **Style Dictionary interchange**: `reverseStyleDictionary(sd)` unwraps
  `{ value: … }` leaves back into plain tokens, pairing with the
  `style-dictionary` output format.
- **Cross-version diffing**: `snapshot` writes the fully resolved token tree;
  `history <a> <b> …` diffs a sequence of snapshots and reports per-version
  transitions (`+added / -removed / ~changed`).
- New library exports: `reverse`, `reverseStyleDictionary`.

### Changed
- **`convert` (css/barefoot) now emits `[data-brand="x"]` blocks** in addition
  to the existing `[data-mode="x"]` blocks, so brands round-trip through
  `reverse` (previously only `kit` emitted brand blocks). This is a behavioral
  change to generated output, which is why this is a major release — existing
  CSS variable names/selectors are unchanged, only brand override blocks are
  added when a `brands`/`brand` key is present.
- `convert` accepts a `brands` option (array) to scope which brand blocks are
  emitted (mirrors the existing `modes` option).

### Notes
- `reverse` is best-effort: kebab-case collisions (e.g. a `color.primary` leaf
  and a `color.primaryHover` token, both kebab to `color-primary-*`) resolve to
  the exact leaf and drop the nested branch. Non-colliding names round-trip
  byte-for-byte (CSS → tree → CSS is identical).

## [2.5.1] - 2026-09-03

### Fixed
- **E2E smoke / parser regression**: multi-part CSS values containing a
  function call (e.g. `"0 4px 6px rgba(0,0,0,0.1)"` in
  `examples/tokens.json`) no longer fail the build with
  `unexpected trailing tokens`. The v2.0 expression parser tripped on the
  `(`, parsed the leading `0` as a complete expression, and threw. Values
  that are not structurally parseable now fall back to verbatim output,
  restoring the pre-2.0 behavior. Unknown/circular references and
  `--strict` unit mismatches still fail hard.

## [2.5.0] - 2026-09-03

### Added
- **Theme Kit**: `token-to-css kit <input> --out-dir dist` emits a cohesive
  theme package — `theme.css` (all `modes` + `brands` as `[data-mode]` /
  `[data-brand]` blocks plus mode×brand combos), a 742-byte `theme.js`
  runtime that flips themes via `data-mode` / `data-brand` / `data-theme`
  (localStorage-persisted), a self-contained `index.html` preview with
  mode/brand switchers, and typed `tokens.ts` / `tokens.js` bindings.
- **`--check`**: dry-run that exits 1 when an `-o` output is stale vs tokens
  (reuses `convert` / `convertToMap` for expected bytes and `diffTokens`
  to summarize JSON drift). Ideal for CI.
- **`lint`**: `token-to-css lint <input> [--contract schema.json] [--json]`
  detects unused / duplicate-value / untyped tokens, broken `$type`,
  unknown references, dangling brand overrides, and missing brand overrides.
- **Contracts**: `--contract <schema.json>` (also `lint --contract` and
  `kit --contract`) enforces required tokens + types via a JSON Schema
  (e.g. as emitted by `--format schema` with added `required` arrays);
  new `checkContract(tokens, schema)` export.
- **Token explorer**: `--serve` now serves a browseable page at `/`
  (every token, value, swatch, copy-to-clipboard + file links); `/explorer`
  alias kept.
- **Docs site**: `--format docs` emits a static, searchable HTML token site
  built on the `report` data; `--format ts` / `--format js` emit typed
  bindings directly.
- New library exports: `lintTokens`, `checkContract`, `buildKit`,
  `buildKitCSS`, `buildThemeJS`, `buildBindings`, `buildPreviewHTML`,
  `splitThemes`, `THEME_JS`, `buildDocsSite`, `buildExplorerHTML`.
- 100 tests passing on Node 20/22.

## [2.0.0] - 2026-09-02

### Changed
- **Node 20+ required** (dropped Node 18).
- **New reference parser**: replaced the spaced-operator heuristic with a real
  tokenizer/parser supporting parentheses, precedence, nested/chained function
  calls, and unknown CSS functions (e.g. `var(--x)`) passed through verbatim.
- Internal restructure into a `core` + plugin model (single package).

### Added
- **Plugin / transform API**: `registerFunction(name, fn)`, `registerFormat(name, fn)`,
  and `registerPlugin({ name, functions, formats })` let consumers add custom
  reference functions and output formats.
- **Config schema v2**: `token-to-css.config.json` / `.token-to-cssrc` /
  `package.json#tokenToCss` with `version: 2`, `inputs`, `outputs` (`[{format,file}]`),
  `presets`, validated with migration from the legacy shape.
- Built-in `rgb()` and `hsl()` color functions.
- 80 tests passing on Node 20/22.

### Notes
- Valid token files produce identical output to 1.x; only internal evaluation
  semantics changed. Use `--strict` to turn unit mismatches into hard errors.

## [1.5.0] - 2026-09-02

### Added
- **Color transform functions**: `alpha(c, p%)`, `lighten(c, p%)`, `darken(c, p%)`,
  `mix(c1, c2, p%)` inside references, composing with `{references}` and arithmetic.
- **Tailwind output**: `--format tailwind` emits a Tailwind v4 `@theme { … }` block.
- **Style Dictionary output**: `--format style-dictionary` emits `{ value: … }` docs.
- **JSON Schema output**: `--format schema` emits a JSON Schema of the token tree.
- **Markdown report**: `--format report` emits a table of every token + resolved value.
- **Multi-brand**: a `brands`/`brand` key with `--brand <name>` to apply overrides.
- **Strict mode**: `--strict` fails the build on unit mismatches (no `calc()` fallback).
- **Token diff**: `--diff a.json b.json` prints added/removed/changed tokens.
- **Preview server**: `--serve` (with `--watch`) serves outputs on `http://localhost:4173`.
- `diffTokens(a, b)` exported for library use.
- 71 tests passing on Node 18/20/22.

## [1.0.0] - 2026-09-02

### Added
- **Stability contract**: the public CLI flag set and library API are frozen and
  follow Semantic Versioning. Documented in `README.md` (Stability & SemVer) and
  `MIGRATION.md`.
- **TypeScript coverage**: added `presets/tailwind.d.ts` and
  `presets/open-props.d.ts`; `index.d.ts` now matches every public export
  (`resolveReferences`, `validateTokens`, `TokenValidationError`, `normalizeW3C`,
  `applyMap`, `toCSSModules`, …).
- **CI hardening**: `test.yml` adds an end-to-end smoke step (CLI runs across
  css/json/tailwind/source-map) on the Node 18/20/22 LTS matrix.
- **npm provenance**: `publish.yml` publishes with `--provenance` from GitHub
  Actions OIDC.
- **Docs**: expanded README cookbook with per-preset and per-format examples;
  added `MIGRATION.md` (0.x → 1.0).

### Stability
- No breaking changes from 0.6.0. 1.0.0 marks the API/CLI freeze; future
  breaking changes require a major version.

## [0.6.0] - 2026-09-02

### Added
- **W3C Design Tokens input**: `$value`/`$type` tokens are auto-detected and
  normalized before conversion.
- **Modes / themes**: a `modes` (or `themes`) key emits `[data-mode="name"]`
  blocks; `--mode` selects specific modes. References resolve across modes.
- **CSS Modules output**: `--format css-modules` emits a `:export { ... }` block
  with camelCased keys.
- **JSON output**: `--format json` emits the fully resolved token tree
  (including resolved modes).
- **Formatter presets**: `--preset tailwind` / `--preset open-props` map tokens
  onto Tailwind v4 / Open Props naming (unknown tokens fall back to `--<name>`).
- **`--stdin`**: read token JSON from standard input for piping.
- **`--initial=false`**: with `--watch`, skip the first build until a file
  changes.
- `normalizeW3C`, `applyMap`, and `toCSSModules` exported for library use.

## [0.5.0] - 2026-09-02

### Added
- `--source-map` (`-M`) writes a standard Source Map v3 (`<file>.map`) next to
  each output, mapping every generated variable back to its source token's
  file + line number. Each output also gets a `/*# sourceMappingURL=… */`
  footer so editors and devtools can jump to the originating token.
- `parseLocated(text, file)` and `convertToMap(tree, locations, options)`
  exports for building source maps programmatically.
- Watch mode now re-scans globs on every change, so deleting a source file
  removes its variables from the output on the next save.

## [0.4.0] - 2026-09-02

### Added
- `--reduce` (default on) collapses `{a} * 2` to a single value (e.g. `2rem`)
  when units allow; mismatched units fall back to `calc()`. `--no-reduce`
  keeps `calc()` always.
- Multiple outputs: repeatable `-o [format:]file` (e.g. `-o css:theme.css
  -o scss:theme.scss`).
- `--watch` re-scans globs and picks up newly created matches.
- `--source-comments` emits a `/* token.path */` note above each variable.

## [0.3.0] - 2026-09-02

### Added
- TypeScript definitions for the public API (`src/index.d.ts`, `schema.d.ts`,
  `presets/barefoot.d.ts`); `package.json` `types` field.
- Zero-dependency `--glob` inputs (repeatable); matched files merge into one
  output. `--watch` watches every resolved file.
- Integration / golden test (`test/integration.test.js`).
- Publish workflow is idempotent (skips if the version is already on npm).

## [0.2.0] - 2026-09-02

### Added
- Multi-file `--import` with deep merge (main wins last).
- Config file (`token-to-css.config.json` / `.token-to-cssrc`) with CLI override.
- Watch mode also watches imported files.

## [0.1.0] - 2026-09-02

### Added
- Convert design token JSON into CSS custom properties (`:root` variables).
- `scss` output format (SCSS `$variables`).
- `barefoot` output format that maps tokens onto barefoot-css `--bf-*` semantic
  variables, wrapped in an optional `[data-bf-theme="name"]` selector.
- CLI with `-o/--output`, `-f/--format`, `-s/--selector`, `-t/--theme`,
  `-m/--map`, `-w/--watch`, `-R/--no-resolve`, and `-n/--no-validate` flags.
- Watch mode (`-w`) that regenerates output whenever the input file changes.
- Custom mapping file (`--map`) to override the built-in barefoot token mapping.
- Token references: `{dotted.path}` substitution with circular/unknown detection.
- Spaced arithmetic in references (e.g. `{spacing.md} * 1.5`) emitted as `calc()`.
- JSON Schema validation (`schema/tokens.schema.json`) of token inputs.
- Node test suite (`node --test`) covering core, CLI, references, and validation.

[Unreleased]: https://github.com/coffeetocoffee/token-to-css/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v2.5.1...v3.0.0
[2.5.1]: https://github.com/coffeetocoffee/token-to-css/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/coffeetocoffee/token-to-css/compare/v2.0.0...v2.5.0
[2.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v1.5.0...v2.0.0
[1.5.0]: https://github.com/coffeetocoffee/token-to-css/compare/v1.0.0...v1.5.0
[1.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/coffeetocoffee/token-to-css/releases/tag/v0.1.0
