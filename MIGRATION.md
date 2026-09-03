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

## From 4.x to 5.0

v5.0 is a **major** because it introduces a long-running server process and new
public contracts (the SSE message schema, the canonical name registry format, the
generated client SDK, and the Figma connector). The existing CLI flags and library
API from 1.x–4.x are unchanged — upgrading is drop-in for `convert`, `lint`,
`kit`, `reverse`, `sync`, etc.

What is **new** (and therefore its contracts may still evolve within the v5.x line
before a v6.0):

- `token-to-css serve <input.json>` — the live Token Server (REST + SSE mesh).
  The SSE channel emits `{ type: "snapshot" | "update", tree }`; treat the exact
  envelope shape as part of the 5.x contract and pin a major range if you depend on it.
- `--registry` / `tokens.names.json` — the canonical name registry that makes
  `reverse(convert(tokens, { registry }))` lossless. The `tokens.names.json`
  shape may change in a minor; consume it with `registryFromJSON`.
- `GET /tokens-client.js` (`buildClientJS`) — the generated client. Guard against
  minor changes by vendoring a copy if you need byte-stability.
- `registerFigmaConnector` / the `figma` format — experimental, opt-in.

| Version | What you can now do |
| ------- | ------------------- |
| 5.0.0   | `serve` (REST+SSE), generated client SDK, lossless canonical name registry, Figma connector (experimental), shareable playground |

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
