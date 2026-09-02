# Migrating to token-to-css 1.0

`token-to-css` follows [Semantic Versioning](https://semver.org). **1.0.0 freezes
the public API and CLI surface** — you can upgrade from any `0.x` release without
code changes. This page documents what is now stable and what to expect going
forward.

## From 0.x to 1.0

There are **no breaking changes**. Every CLI flag and library function available
in `0.6.0` behaves identically in `1.0.0`. New capabilities added across `0.x`
are summarized below so you can adopt them if useful:

| Version | What you can now do                                   |
| ------- | ----------------------------------------------------- |
| 0.2.0   | `--import` / `--glob` multi-file tokens + config file |
| 0.3.0   | TypeScript types, glob inputs, CI publish             |
| 0.4.0   | `--reduce` arithmetic, multiple `-o` outputs, `--source-comments` |
| 0.5.0   | `--source-map` (`.css.map`), watch drops deleted files |
| 0.6.0   | W3C `$value` tokens, modes, `css-modules`/`json`, presets, `--stdin`, `--initial=false` |

## Stability guarantees (from 1.0.0)

- **CLI flags** will not be removed or renamed except in a major version, and
  only after a deprecation period with a runtime warning.
- **Library functions** (`convert`, `convertToMap`, `flattenTokens`,
  `normalizeW3C`, `applyMap`, `toCSS`, `toSCSS`, `toBarefoot`, `toCSSModules`,
  `buildSourceMap`, `resolveReferences`, `validateTokens`, `parseLocated`) and
  their TypeScript types are part of the supported contract.
- **Output formats and variable naming** are stable within a major version.
- **Node 18+ LTS** is supported (tested on 18, 20, 22).

## If you were using a private fork

The published package is zero-dependency and ships only `src/` and the schema.
Pin your dependency to a major range to avoid surprises:

```json
"dependencies": {
  "token-to-css": "^1.0.0"
}
```
