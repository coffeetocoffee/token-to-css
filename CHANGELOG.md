# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/coffeetocoffee/token-to-css/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/coffeetocoffee/token-to-css/releases/tag/v0.1.0
