# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/coffeetocoffee/token-to-css/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v1.5.0...v2.0.0
[1.5.0]: https://github.com/coffeetocoffee/token-to-css/compare/v1.0.0...v1.5.0
[1.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/coffeetocoffee/token-to-css/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/coffeetocoffee/token-to-css/releases/tag/v0.1.0
