# token-to-css

> Convert a design token JSON file into framework-agnostic CSS. Generates CSS custom properties by default, with support for SCSS variables and a barefoot-css flavored output.

[![npm version](https://img.shields.io/npm/v/token-to-css)](https://www.npmjs.com/package/token-to-css)
[![npm downloads](https://img.shields.io/npm/dm/token-to-css)](https://www.npmjs.com/package/token-to-css)
[![CI](https://img.shields.io/github/actions/workflow/status/coffeetocoffee/token-to-css/test.yml)](https://github.com/coffeetocoffee/token-to-css/actions)
[![v5.0.0](https://img.shields.io/badge/phase-5.0.0%20%E2%80%94%20major-2b7a4f)](https://github.com/coffeetocoffee/token-to-css)
[![MIT license](https://img.shields.io/npm/l/token-to-css)](LICENSE)

## Install

```bash
npm install -g token-to-css
```

Or run directly with Node 20+:

```bash
node src/cli.js tokens.json -o output.css
```

## Usage

```bash
token-to-css <input.json> [options]
token-to-css kit <input.json> [--out-dir dist] [options]
token-to-css lint <input.json> [--contract schema.json] [--json]
token-to-css reverse <file.css> [-o tokens.json] [--registry names.json]
token-to-css snapshot <input.json> [-o snap.json]
token-to-css history <snap-a.json> <snap-b.json> [snap-c.json ...]
token-to-css sync <input.json> [options]   # generate, then watch + reverse-sync edits back
token-to-css serve <input.json> [--port 4173] [--playground] [--registry]   # live Token Server mesh

Options:
  -o, --output <[fmt:]file>  Write output (repeatable); e.g. scss:out.scss
  -f, --format <name>   css | scss | barefoot | css-modules | json | tailwind | style-dictionary | schema | report | docs | ts | js  (default: css)
  -s, --selector <sel>  CSS selector for variables (default: :root)
  -t, --theme <name>    barefoot only: wrap in [data-bf-theme="name"]
  -m, --map <file>      barefoot only: JSON file mapping token names to vars
  -i, --import <file>   Merge additional token files (repeatable)
  -g, --glob <pattern>  Merge files matching a glob (repeatable)
  -c, --config <file>   Config file with default options (default: auto-detect)
  -w, --watch           Re-generate whenever an input file changes
  -R, --no-resolve      Do not resolve {token} references
  -z, --no-reduce       Keep arithmetic as calc() instead of collapsing it
  -C, --source-comments Emit a /* token.path */ comment above each variable
  -M, --source-map      Write a `<file>.map` source map alongside each output
  -P, --preset <name>   Map tokens via a built-in preset: tailwind | open-props
  --mode <name>         Emit a [data-mode="name"] block (repeatable; reads `modes`)
  --brand <name>        Apply a named brand override from a `brands`/`brand` key
  --stdin               Read token JSON from standard input
  --strict              Fail on arithmetic with mismatched units (no `calc()` fallback)
  --diff <a> <b>        Print a token diff report for two token files, then exit
  --check               Dry-run: fail (exit 1) when an -o output is stale vs tokens
  --contract <file>     Enforce required tokens + types via a JSON Schema file
  --out-dir <dir>       Output directory for the kit subcommand (default: dist)
  --registry            Emit/consume a canonical name registry (lossless round-trip)
  --playground         With serve: host the live kit preview + "propose change"
  --json                With lint: print issues as JSON
  --serve               Serve generated outputs on a local HTTP server (with -w)
  --port <n>            Port for --serve (default: 4173)
  --initial=false       With --watch, skip the first build until a file changes
  -n, --no-validate     Skip token validation
  -h, --help            Show help
```

### More formats & tooling

| Format             | Output                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `css`              | CSS custom properties under `:root` (default)                     |
| `scss`             | SCSS `$variables`                                                 |
| `barefoot`         | barefoot-css `--bf-*` variables                                   |
| `css-modules`      | a CSS Modules `:export { ... }` block                             |
| `json`             | the fully resolved token tree as JSON                             |
| `tailwind`         | a Tailwind v4 `@theme { ... }` block                              |
| `style-dictionary` | a [Style Dictionary](https://github.com/amazon-style-dictionary/style-dictionary) document (`{ value: ... }`) |
| `schema`           | a JSON Schema describing the token structure                      |
| `report`           | a Markdown table of every token and its resolved value            |
| `docs`             | a static, searchable HTML token site (built on the report data)   |
| `ts`               | typed bindings (`tokens.ts`: `TokenName`, `TokenMap`, consts)     |
| `js`               | typed bindings (`tokens.js`: `tokens` map + consts)               |

```bash
token-to-css tokens.json -f tailwind -o theme.css
token-to-css tokens.json -f style-dictionary -o tokens.sd.json
token-to-css tokens.json -f schema -o tokens.schema.json
token-to-css tokens.json -f report -o tokens.md
token-to-css tokens.json -f docs -o docs.html
token-to-css tokens.json -f ts -o tokens.ts
```

**Color transforms.** References can call functions on colors:
`alpha(#3b82f6, 50%)`, `lighten(#000, 20%)`, `darken(#fff, 20%)`,
`mix(#f00, #00f, 50%)`. These compose with `{references}` and arithmetic.

**Multi-brand.** Put brand overrides under a `brands` (or `brand`) key and
select one with `--brand acme`:

```json
{ "color": { "primary": "#3b82f6" }, "brands": { "acme": { "color": { "primary": "#ff0000" } } } }
```

```bash
token-to-css tokens.json --brand acme -o theme.css
```

**Strict mode.** `--strict` turns unit mismatches (e.g. `1rem + 1px`) into a
hard error instead of emitting `calc()`.

**Diff.** Compare two token files and print added/removed/changed tokens:

```bash
token-to-css --diff before.json after.json
```

**Preview server.** `--serve` (optionally with `--watch`) serves the generated
outputs on `http://localhost:4173` for quick visual inspection. The index
page is a token explorer: every variable with its value, a swatch, a
copy-to-clipboard button, a live filter, and links to each output file.

**Theme kit.** One command turns a token file into a shippable, typed,
runtime-switchable design system:

```bash
token-to-css kit tokens.json --out-dir dist
# dist/theme.css   all modes + brands as [data-mode]/[data-brand] blocks (plus combos)
# dist/theme.js    ~1KB runtime: window.setTheme({ mode, brand }), persisted to localStorage
# dist/tokens.ts   typed bindings (TokenName, TokenMap, per-token consts)
# dist/tokens.js   JS bindings (tokens map + per-token consts)
# dist/index.html  self-contained preview with mode/brand switchers
```

```html
<link rel="stylesheet" href="theme.css" />
<script src="theme.js"></script>
<script>window.setTheme({ mode: "dark", brand: "acme" });</script>
```

**Token health.** `lint` answers "is this token set healthy?":

```bash
token-to-css lint tokens.json
# warning: [unused] unused token "color-primary": never referenced by another token
# warning: [duplicate-value] duplicate value "#fff" shared by: a, b
# warning: [untyped] untyped token "color.primary": $value without $type
# error: [broken-type] broken $type at "color.primary": unknown type "nope"
# lint: 1 error(s), 3 warning(s)
```

**Contracts.** Enforce required tokens + `$type` via a JSON Schema (e.g. as
emitted by `--format schema` with added `required` arrays):

```bash
token-to-css tokens.json --contract contract.json -o theme.css
token-to-css lint tokens.json --contract contract.json
```

**CI guard.** `--check` fails when generated output is stale vs tokens:

```bash
token-to-css tokens.json -o theme.css --check || npm run build:tokens
```

**Reverse (CSS/SCSS → tokens).** `reverse` parses generated CSS/SCSS back into a
token tree — best-effort round-trip. `:root` becomes the base tree,
`[data-mode="x"]` folds into `modes.x`, `[data-brand="x"]` folds into
`brands.x`, and barefoot `--bf-*` vars map back to token paths:

```bash
token-to-css reverse theme.css -o tokens.json
```

Values are kept verbatim (already resolved in generated output). Because
kebab-case is lossy, a `color.primary` leaf and a `color.primaryHover` token
both kebab to `color-primary-*`: on collision the exact leaf wins and the nested
branch is dropped. Non-colliding token names round-trip byte-for-byte
(`reverse` → `convert` reproduces the original CSS).

**Style Dictionary interchange.** `reverseStyleDictionary(sd)` unwraps
`{ value: … }` leaves back into plain tokens, pairing with the
`style-dictionary` output format for two-way interchange.

**Cross-version diffing.** `snapshot` captures the fully resolved tree, and
`history` diffs a sequence of snapshots across versions:

```bash
token-to-css snapshot tokens@1.json -o snap-1.json
token-to-css snapshot tokens@2.json -o snap-2.json
token-to-css history snap-1.json snap-2.json
# ## snap-1.json -> snap-2.json: +0 -1 ~3
#   ~ color-primary: #111 -> #222
```

**Living design system (`sync`).** _Experimental._ `sync` keeps `tokens.json`
authoritative *and* reconciles external edits to generated artifacts. It
generates the outputs once, then watches both the source file (forward:
regenerate) and the emitted artifacts (reverse: an edit to the CSS is parsed
back with `reverse` and folded into `tokens.json`, then everything re-emits):

```bash
token-to-css sync tokens.json --out-dir dist
# dist/theme.css edited by hand -> token-to-css sync folds it back into tokens.json
```

Reverse-sync only applies unambiguous (non-colliding) names; colliding kebab-case
names are skipped and reported. Generation is idempotent, so `sync` never
re-triggers on its own output. Its behavior and library API may change in a
**minor** release while it bakes — it is not covered by the major-version
stability guarantee.

**Drift reporting.** `computeDrift(source, reversed)` returns the per-group
(`base`, `modes.*`, `brands.*`) added/changed token names, the basis for a
"what diverged and why" report. Also experimental.

## Token Server (v5.0 — live design-system mesh)

`v4.0`'s `sync` made the token file bidirectional and local. v5.0 makes it
**distributed and live**: a running service that is the single runtime source of
truth for an entire org, not just a build step.

```bash
token-to-css serve tokens.json --port 4173 --registry
```

- **REST API**
  - `GET /tokens` — the fully resolved tree as JSON.
  - `GET /tokens?mode=dark&brand=acme` — the same tree with `modes`/`brands`
    overrides applied.
  - `GET /tokens/color.primary` — a single resolved value (`{ path, value }`).
  - `GET /tokens.names.json` — the canonical name registry (when `--registry`).
- **Live push (SSE).** `GET /events` streams `{ type: "snapshot" | "update", tree }`
  the instant the file changes, a reverse-edit lands, or a connector pushes.
- **Generated client SDK.** `GET /tokens-client.js` returns `TokenClient`, which
  subscribes to the stream, hot-swaps `data-mode`/`data-brand` with zero rebuild,
  and exposes the same typed tree `kit` emits. Drop it into any app:

  ```html
  <script src="http://localhost:4173/tokens-client.js"></script>
  <script>const client = TokenClient({ streamUrl: "/events" });</script>
  ```
- **Bidirectional over the wire.** `POST /tokens` (write scope) folds a submitted
  tree into `tokens.json` via `applyReversedIntoSource` and re-broadcasts to all
  subscribers. Idempotent — a no-op submission does not re-trigger a write loop.
  `serve` is `sync`'s two-way loop exposed over the network.

**Canonical name registry (`--registry`).** Kebab-case collisions (`color.primary`
leaf vs `color.primary.hover` nested) used to make `reverse` lossy. With a
registry, every token path gets a unique canonical name and the mapping is
invertible, so `reverse(convert(tokens, { registry }))` reproduces `tokens`
byte-for-byte. The registry is emitted as `tokens.names.json` alongside outputs
and consumed by `reverse --registry <file>`; `sync` and `serve` stop reporting
skipped kebab collisions.

**Figma connector (experimental, opt-in).** `registerFigmaConnector()` registers
a `figma` output format and returns `push`/`pull` adapters for the Figma REST
API (no hard dependency on Figma's SDK), so token changes flow both ways between
the mesh and the design canvas.

```js
import { registerFigmaConnector } from "token-to-css/connectors/figma.js";
const figma = registerFigmaConnector({ token, fileKey });
await figma.push(tokens);            // tokens -> Figma variables
const back = await figma.pull();     // Figma variables -> tokens
```

## Stability & SemVer

`token-to-css` follows **Semantic Versioning**.

- **CLI flags** listed above are stable. Removing or renaming a flag will only
  happen in a major version, and will be preceded by a deprecation period with a
  runtime warning.
- **Library API**: `convert`, `convertToMap`, `flattenTokens`, `normalizeW3C`,
  `applyMap`, `toCSS` / `toSCSS` / `toBarefoot` / `toCSSModules`,
  `buildSourceMap`, `resolveReferences`, `registerFunction`, `registerFormat`,
  `registerPlugin`, `validateTokens`, `parseLocated`, `lintTokens`,
  `checkContract`, `buildKit` / `buildKitCSS` / `buildThemeJS` / `buildBindings` /
  `buildPreviewHTML` / `splitThemes`, `buildDocsSite`, `buildExplorerHTML`,
  `reverse`, `reverseStyleDictionary`, and the TypeScript types are part of the
  supported contract. Breaking changes to these require a major version bump.
- **Output shape**: CSS variable names, selectors, and the Source Map v3 format
  are stable. New output formats are added in minor versions and never change
  existing ones.
- **Node support**: Node 20+. We run the test suite on Node 20 and 22.

2.0.0 was a major release (Node 20+ required; new expression parser). See
[CHANGELOG.md](./CHANGELOG.md) for details.

### Output formats

`-f` / `--format` selects the output. The repeatable `-o` flag accepts an
optional `[format]:` prefix for per-file formats.

| Format        | Output                                              |
| ------------- | --------------------------------------------------- |
| `css`         | CSS custom properties under `:root` (default)       |
| `scss`        | SCSS `$variables`                                   |
| `barefoot`    | barefoot-css `--bf-*` variables                     |
| `css-modules` | a CSS Modules `:export { ... }` block               |
| `json`        | the fully resolved token tree as JSON               |

```bash
token-to-css tokens.json -o css:theme.css -o scss:theme.scss -o json:tokens.resolved.json
```

### Presets

`--preset tailwind` or `--preset open-props` maps your token names onto a
well-known external naming scheme (Tailwind v4 `@theme` variables, or
Open Props). Unknown tokens fall back to `--<name>`. Combine with `--map` to
override individual names.

```bash
token-to-css tokens.json --preset tailwind -o theme.css
```

### W3C Design Tokens

Input may use the [W3C Design Tokens](https://tr.designtokens.org/) shape with
`$value` (and `$type`); it is auto-detected and normalized before conversion:

```json
{ "color": { "primary": { "$value": "#3b82f6" } } }
```

### Modes / themes

Define a `modes` (or `themes`) key; each entry becomes a
`[data-mode="name"]` block on top of the base tokens. Use `--mode` to emit only
specific modes. References resolve across the base and the mode.

```json
{
  "color": { "primary": "#3b82f6" },
  "modes": { "dark": { "color": { "primary": "#1e3a8a" } } }
}
```

```bash
token-to-css tokens.json --mode dark -o theme.css
```

### Reading from a pipe

```bash
cat tokens.json | token-to-css --stdin -o theme.css
```

Watch mode regenerates the output on every save:

```bash
token-to-css tokens.json -o theme.css -w
```

## Multi-file tokens

Merge additional files with `--import` (repeatable). Later files override
earlier, the main input wins last:

```bash
token-to-css tokens.json --import colors.json --import spacing.json -o theme.css
```

Glob patterns are also supported via `--glob` (repeatable):

```bash
token-to-css --glob "src/**/*.tokens.json" -o theme.css
```

### Multiple outputs

Pass `-o` more than once to emit several formats in one run. Prefix a path
with a format to pick the format per file:

```bash
token-to-css tokens.json -o css:theme.css -o scss:theme.scss -o barefoot:barefoot.css
```

### Arithmetic

Expressions with spaced operators are collapsed when possible and otherwise
emitted as `calc()`:

```json
{ "spacing": { "md": "1rem", "lg": "{spacing.md} * 2" } }
```

```css
--spacing-md: 1rem;
--spacing-lg: 2rem;        /* collapsed */
```

Use `--no-reduce` to always keep `calc(...)`. Add `--source-comments` to emit
a `/* token.path */` note above each variable for traceability.

### Source maps

Pass `--source-map` to emit a standard [Source Map](https://sourcemaps.info/)
(next to each output file, e.g. `theme.css.map`) that points every generated
CSS variable back to the source token's file and line. Each output gets a
`/*# sourceMappingURL=… */` footer so editors and devtools can jump straight to
the originating token.

```bash
token-to-css tokens.json -o theme.css --source-map
```

Watch mode also re-globs on every change, so **deleting** a source file drops
its variables from the output on the next save.

## Config file

Place `token-to-css.config.json` (or `.token-to-cssrc`) in the project root
to set defaults:

```json
{
  "format": "barefoot",
  "theme": "brand",
  "imports": ["colors.json", "spacing.json"]
}
```

CLI flags override config. Watch mode also watches imported files.

## Barefoot-css preset

The `barefoot` format maps common token names onto barefoot-css's semantic
`--bf-*` variables, so your design tokens become a drop-in theme:

```bash
token-to-css tokens.json -f barefoot -t brand -o brand-theme.css
```

```css
/* barefoot-css theme tokens */
[data-bf-theme="brand"] {
  --bf-primary: #3b82f6;
  --bf-surface: #ffffff;
  --bf-text: #0f172a;
  /* ... */
}
```

Load it by setting the attribute on `<html>`:

```html
<html data-bf-theme="brand">
```

### Custom mapping

Your token names don't match the built-ins? Pass a map file with
`--map` (flat token name → CSS variable). Custom entries override the
built-in table.

`map.json`:

```json
{
  "brand": "--bf-primary",
  "canvas": "--bf-surface",
  "ink": "--bf-text"
}
```

```bash
token-to-css tokens.json -f barefoot -m map.json -o theme.css
```

Any token not found in the map falls back to `--bf-<name>`.

Mapping highlights (anything unrecognized falls back to `--bf-<name>`):

| Token path            | barefoot variable     |
| --------------------- | --------------------- |
| `color.primary`       | `--bf-primary`        |
| `color.background`    | `--bf-surface`        |
| `color.text`          | `--bf-text`           |
| `color.danger`        | `--bf-danger`         |
| `radius` / `radius-sm`| `--bf-radius` / `--bf-radius-sm` |
| `spacing.4`           | `--bf-space-4`        |
| `font.family`         | `--bf-font`           |
| `shadow`              | `--bf-shadow`         |

## Tests

```bash
npm test
```

## Example

`tokens.json`:

```json
{
  "color": { "primary": "#3b82f6" },
  "spacing": { "md": "1rem" }
}
```

```bash
token-to-css tokens.json -f css
```

```css
:root {
  --color-primary: #3b82f6;
  --spacing-md: 1rem;
}
```

## Token format

Any nested JSON object. Keys are flattened into kebab-case variable names:

- `color.primary` -> `--color-primary`
- `font.size.lg` -> `--font-size-lg`

### References

String values can reference other tokens with `{dotted.path}`. Spaced
arithmetic (`+ - * /`) is emitted as `calc()`:

```json
{
  "spacing": { "md": "1rem" },
  "gap": "{spacing.md} * 1.5"
}
```

```css
:root {
  --spacing-md: 1rem;
  --gap: calc(1rem * 1.5);
}
```

References are resolved recursively and validated (unknown/cirular refs error
out). Disable with `--no-resolve`.

### Validation

Input is validated against `schema/tokens.schema.json` before conversion:
groups must be objects, leaves must be strings/numbers/booleans, and every
`{reference}` must resolve. Invalid input exits non-zero with a message. Skip
with `--no-validate`.

## Cookbook

**Tailwind v4 theme.** Map tokens onto Tailwind's `@theme` variable names:

```bash
token-to-css tokens.json --preset tailwind -o theme.css
# :root { --color-primary: #3b82f6; --text-lg: 1.125rem; }
```

**Open Props.** Same idea, mapped onto Open Props tokens:

```bash
token-to-css tokens.json --preset open-props -o theme.css
# :root { --indigo-6: #3b82f6; }
```

**Light/dark modes.** Define a `modes` key (or `themes`); each entry becomes a
scoped block. References resolve across the base and the mode:

```json
{
  "color": { "primary": "#3b82f6", "onPrimary": "{color.primary}" },
  "modes": { "dark": { "color": { "primary": "#1e3a8a" } } }
}
```

```bash
token-to-css tokens.json --mode dark -o theme.css
# :root { --color-primary: #3b82f6; --color-on-primary: #3b82f6; }
# :root[data-mode="dark"] { --color-primary: #1e3a8a; --color-on-primary: #1e3a8a; }
```

**W3C Design Tokens in.** `$value` / `$type` shapes are accepted as-is:

```json
{ "color": { "primary": { "$value": "#3b82f6" } } }
```

**CSS Modules.** Export camelCased variables for a bundler:

```bash
token-to-css tokens.json -f css-modules -o tokens.css
# :export { colorPrimary: #3b82f6; }
```

**Pipe from another tool.** Read tokens from stdin, emit resolved JSON for
downstream consumers:

```bash
cat tokens.json | token-to-css --stdin -f json -o resolved.json
```

**Debuggable output.** Add a comment per variable, or a source map:

```bash
token-to-css tokens.json --source-comments -o theme.css
token-to-css tokens.json --source-map -o theme.css   # writes theme.css.map
```

## Library use

```js
import { convert } from "token-to-css";
import { validateTokens } from "token-to-css/schema.js";
import tokens from "./tokens.json" assert { type: "json" };

validateTokens(tokens);
const css = convert(tokens, { format: "barefoot" });
```

`convert` also accepts `format` (`css` | `scss` | `barefoot` | `css-modules` |
`json` | `tailwind` | `style-dictionary` | `schema` | `report` | `docs` | `ts` |
`js`), `preset` (`"tailwind"` | `"open-props"`), `modes` (string array),
`brand`, `strict`, `reduce`, `resolve`, `sourceComments`, and W3C `$value`
input (auto-detected).

`convertToMap(tree, locations, options)` returns `{ css, map }` where `map` is a
Source Map v3 object. `locations` maps each flat token name (kebab-cased) to
`{ file, line }`; build it with `parseLocated(text, file).loc`.

```js
import { convertToMap, parseLocated } from "token-to-css";

const { tree, loc } = parseLocated(fileText, "tokens.json");
const { css, map } = convertToMap(tree, loc, { format: "css" });
```

## Extending with plugins

`token-to-css` v2 exposes a plugin API for custom reference functions and custom
output formats (the package stays a single module — no scoped publish).

```js
import { registerPlugin, registerFunction, registerFormat, convert } from "token-to-css";

// a custom reference function usable in tokens: contrast({color.fg}, {color.bg})
registerFunction("contrast", (args) => (args[0].value > args[1].value ? "dark" : "light"));

// a custom output format selected with --format myfmt
registerFormat("myfmt", (flat, opts) =>
  Object.entries(flat).map(([k, v]) => `${k}: ${v};`).join("\n")
);

// or all at once
registerPlugin({
  name: "acme",
  functions: { ramp: (args) => `/* ${args[0].value} */` },
  formats: { acme: (flat) => JSON.stringify(flat) },
});

convert(tokens, { format: "myfmt" });
```

Registered functions receive an array of already-evaluated argument values
(`{ kind: "num", value, unit }` or `{ kind: "str", value }`) and must return a
string. Registered formats receive the flat `name -> value` map and the options.

## Config file (v2)

Auto-detected from `token-to-css.config.json` / `.token-to-cssrc` / the
`tokenToCss` key in `package.json`. v2 adds a structured schema with validation
and migration from the legacy (version-less) shape:

```json
{
  "version": 2,
  "inputs": ["tokens.json"],
  "outputs": [{ "format": "css", "file": "theme.css" }],
  "preset": "tailwind",
  "modes": ["dark"],
  "brand": "acme"
}
```

## Breaking changes in 2.0

- **Node 20+ is now required** (dropped Node 18).
- The reference evaluator was replaced by a real expression parser. Valid token
  files produce identical output, but the internal heuristics changed; arithmetic
  with mismatched units now falls back to `calc()` (or errors under `--strict`),
  and parenthesized / nested expressions are fully supported.
- The package is internally restructured into a `core` + plugin model; the public
  API (`convert`, `convertToMap`, `registerPlugin`, …) is unchanged.
