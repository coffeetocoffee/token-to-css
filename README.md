# token-to-css

> Design tokens in — CSS, SCSS, Tailwind, docs, typed bindings, and a live
> design-system mesh out. Zero runtime dependencies, Node 20+.

[![npm version](https://img.shields.io/npm/v/token-to-css)](https://www.npmjs.com/package/token-to-css)
[![GitHub Release](https://img.shields.io/github/v/release/coffeetocoffee/token-to-css)](https://github.com/coffeetocoffee/token-to-css/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/coffeetocoffee/token-to-css/test.yml)](https://github.com/coffeetocoffee/token-to-css/actions)
[![v11.5.0](https://img.shields.io/badge/phase-11.5.0%20%E2%80%94%20the%20real%20package%20split-2b7a4f)](https://github.com/coffeetocoffee/token-to-css)
[![MIT license](https://img.shields.io/npm/l/token-to-css)](LICENSE)

## Install

```bash
npm install -D token-to-css        # or -g for a global CLI
npx token-to-css tokens.json -o theme.css
```

## Quick start

```json
{ "color": { "primary": "#3b82f6" }, "spacing": { "md": "1rem" } }
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

That is the whole core. Everything below is opt-in.

## CLI

| Command | What it does |
| ------- | ------------ |
| *(default)* | convert a token file to one or more outputs |
| `kit` | emit a theme package (CSS + runtime + typed bindings + preview) |
| `lint` | token health: unused / duplicate / untyped / broken `$type` / deprecated-in-use |
| `reverse` | parse CSS/SCSS back into a token tree |
| `snapshot` / `history` | resolved-tree snapshots + cross-version diffs |
| `sync` | watch tokens *and* artifacts; fold external edits back (experimental) |
| `serve` | the live Token Server: REST + SSE, editor, connectors, relay |
| `migrate` | rename/deprecation codemods from the impact graph |
| `federate` | compose team and org token trees via a manifest |
| `govern` | stamp `$version`, deprecate tokens with `replacedBy` |
| `adopt` | lint consumer code for hardcoded values; `--fix` rewrites them |
| `mcp` | Model Context Protocol server for AI coding agents |
| `release` / `lock` / `bisect` | token-set semver, breaking-change alerts, time travel |

Common flags (see `--help` for everything):

```bash
-o, --output <[fmt:]file>   output file (repeatable); prefix picks the format
-f, --format <name>         output format (default: css)
-i, --import <file>         merge extra token files (repeatable)
-g, --glob <pattern>        merge files matching a glob (repeatable)
-w, --watch                 regenerate on change
    --mode <name>           emit a [data-mode="name"] block (repeatable)
-B, --brand <name>          apply a brand override from a brands key
-P, --preset <name>         tailwind | open-props
-R, --no-resolve            keep {token} references unresolved
-z, --no-reduce             keep arithmetic as calc() instead of collapsing
-M, --source-map            write a Source Map v3 next to each output
-C, --source-comments       emit a /* token.path */ note above each variable
    --registry              canonical name registry (lossless round-trips)
    --check                 CI guard: fail when an output is stale vs tokens
    --diff <a> <b>          print a token diff report
-n, --no-validate           skip input validation
```

## Token files

Any nested JSON object. Keys flatten to kebab-case variables:
`color.primary` → `--color-primary`, `font.size.lg` → `--font-size-lg`.

**References.** Values can reference other tokens; spaced arithmetic collapses
when units allow and otherwise emits `calc()`:

```json
{ "spacing": { "md": "1rem", "lg": "{spacing.md} * 2" } }
```

```css
--spacing-md: 1rem;
--spacing-lg: 2rem;
```

**Color transforms.** `alpha()`, `lighten()`, `darken()`, `mix()` compose with
references, and tokens may be authored in `oklch()` / `oklab()` / `lab()` /
`lch()` directly:

```json
{ "color": { "muted": "lighten({color.primary}, 20%)" } }
```

**W3C Design Tokens** (`$value` / `$type`) are auto-detected and normalized:

```json
{ "color": { "primary": { "$value": "#3b82f6", "$type": "color" } } }
```

**Modes & brands.** A `modes` (or `themes`) key emits `[data-mode="x"]` blocks;
a `brands` key emits `[data-brand="x"]` blocks. References resolve across the
base and each override:

```bash
token-to-css tokens.json --mode dark --brand acme -o theme.css
```

## Output formats

```bash
token-to-css tokens.json -o css:theme.css -o scss:theme.scss -o ts:tokens.ts
```

| Format | Output |
| ------ | ------ |
| `css` *(default)* | custom properties under `:root` + `[data-mode]`/`[data-brand]` blocks |
| `scss` | SCSS `$variables` |
| `barefoot` | barefoot-css `--bf-*` variables |
| `css-modules` | a CSS Modules `:export { ... }` block |
| `json` | the fully resolved token tree |
| `tailwind` | a Tailwind v4 `@theme` block |
| `style-dictionary` | a Style Dictionary document (`{ value: ... }`) |
| `schema` | a JSON Schema of the token structure |
| `report` | a Markdown table of every token |
| `docs` | a static, searchable HTML token site |
| `provenance` | an HTML page with each token's "used by" graph |
| `ts` / `js` | typed bindings (`tokens.ts` / `tokens.js`) |
| `figma` | Figma variables JSON (connector format) |
| `storybook` | a Storybook theme doc |
| `github` | a GitHub PR file map |
| `cms` | a CMS entries array (Contentful/Sanity-style) |

## Presets

`--preset tailwind` / `--preset open-props` map token names onto those
naming schemes (unknown tokens fall back to `--<name>`); `-f barefoot` maps
onto barefoot-css's `--bf-*` variables. Combine with `--map file.json` to
override individual names.

## Build workflow

**Multiple inputs.** `--import` merges files (last wins); `--glob` merges
matches. `cat tokens.json | token-to-css --stdin` reads a pipe. Watch mode
(`-w`) re-globs on every change, so deleted files drop out of the output.

**Config.** Defaults live in `token-to-css.config.json`, `.token-to-cssrc`,
or the `tokenToCss` key of `package.json` (schema v2 with validation). CLI
flags override config.

```json
{
  "version": 2,
  "inputs": ["tokens.json"],
  "outputs": [{ "format": "css", "file": "theme.css" }],
  "preset": "tailwind",
  "modes": ["dark"]
}
```

**Health & CI.**

```bash
token-to-css lint tokens.json                       # unused/duplicate/untyped/broken refs
token-to-css tokens.json --contract schema.json     # enforce required tokens + $type
token-to-css tokens.json -o theme.css --check       # exit 1 when output is stale
token-to-css --diff v1.json v2.json                 # added / removed / changed
token-to-css snapshot tokens@2.json -o snap.json    # resolved tree for history diffs
token-to-css history snap-1.json snap-2.json
```

**Traceability.** `--source-map` writes a Source Map v3 per output so editors
jump from a variable to its token; `--source-comments` inlines a
`/* token.path */` note above each variable.

## Theme kit

One command turns a token file into a shippable, typed, runtime-switchable
design system:

```bash
token-to-css kit tokens.json --out-dir dist
```

```
dist/theme.css    all modes + brands as [data-mode]/[data-brand] blocks
dist/theme.js     ~1KB runtime: window.setTheme({ mode, brand })
dist/tokens.ts    typed bindings (TokenName, TokenMap, consts)
dist/tokens.js    JS bindings
dist/index.html   self-contained preview with mode/brand switchers
```

```html
<link rel="stylesheet" href="theme.css" />
<script src="theme.js"></script>
<script>window.setTheme({ mode: "dark", brand: "acme" });</script>
```

## Round-trip: reverse, sync, registry

**`reverse`** parses generated CSS/SCSS back into a token tree: `:root`
becomes the base, `[data-mode="x"]` folds into `modes.x`, `[data-brand="x"]`
into `brands.x`, barefoot `--bf-*` vars map back to paths.

```bash
token-to-css reverse theme.css -o tokens.json
```

**Registry (`--registry`).** Kebab-case is lossy for colliding names. With a
registry, every token path gets a unique canonical name and the mapping is
invertible — `reverse(convert(tokens, { registry }))` is byte-for-byte. The
registry is emitted as `tokens.names.json` alongside outputs.

**`sync`** *(experimental)* keeps `tokens.json` authoritative while watching
both directions: source changes regenerate outputs; hand-edits to the CSS are
parsed back and folded into the token file. Generation is idempotent, so it
never re-triggers on its own output. `computeDrift(source, reversed)` reports
per-group divergence.

## Token Server

```bash
token-to-css serve tokens.json --port 4173 --registry
```

- **REST** — `GET /tokens` (`?mode=&brand=` apply overrides),
  `GET /tokens/<dotted.path>`, `GET /tokens.names.json`.
- **Live push** — `GET /events` streams `{ type, tree }` the instant the file
  changes, a reverse-edit lands, or a connector pushes.
- **Client SDK** — `GET /tokens-client.js` returns a framework-agnostic
  `TokenClient` that hot-swaps `data-mode` / `data-brand` with zero rebuild:

  ```html
  <script src="http://localhost:4173/tokens-client.js"></script>
  <script>const client = TokenClient({ streamUrl: "/events" });</script>
  ```

- **Two-way** — `POST /tokens` folds a submitted tree into `tokens.json` and
  re-broadcasts. Idempotent: a no-op submission never re-triggers a write.
- **Auth** — `--auth tokens.json` (a `{ token: "read" | "write" }` map, or
  `{ tokens: [{ token, scope }] }`). Every request sends
  `Authorization: Bearer <token>`; reads need read+, writes need write
  (403 otherwise, source never mutated).
- **Channels** — `--canary staging.json` streams a canary tree to
  `/tokens?channel=canary`; `POST /promote` promotes it to stable.
- **Change requests** — `--approve` turns every write into a pending CR:
  `POST /tokens` → 202, then
  `POST /change-requests/:id/approve | reject`. Team rooms:
  `GET /teams`, `GET|POST /teams/:team/tokens`, `GET /teams/:team/events`.

## Visual token editor

Served by `serve` at `GET /editor` (on by default; `--editor=false` to
disable) — no new process or protocol:

- type-aware editing: color picker, ±10% dimension steppers;
- mode/brand pickers land edits in the right subtree;
- unknown `{refs}` and unparseable colors are rejected before commit;
- diff-before-commit with the semver verdict — a removal (major) is blocked
  unless confirmed; every preview carries the impact graph and, for renames,
  the ready-to-run codemod;
- commits reuse the governed `POST /tokens` write scope (403 read-only,
  202 with `--approve`, `?channel=canary`); draft values preview live without
  touching the source.

## Connectors

A two-way hub between tokens and the rest of the stack. `serve` exposes every
registered connector (`GET /connectors`,
`POST /connectors/:name/{pull|push}`) so a change round-trips the mesh with
zero core changes:

```js
import { registerConnector } from "token-to-css";

registerConnector({
  name: "my-tool",
  pull: async () => ({ color: { primary: "#3b82f6" } }), // external -> tokens
  push: async (tree) => { /* tokens -> external */ },
  formats: { mytool: (flat, opts) => JSON.stringify(flat) }, // optional
});
```

Built-ins (each ships pure `tokensTo*` / `*ToTokens` round-trips plus
adapters gated on an injected `fetchImpl` — zero runtime deps; experimental):

| Connector | Register with |
| --------- | ------------- |
| Figma | `registerFigmaConnector({ token, fileKey })` |
| Storybook | `registerStorybookConnector({ url, token? })` |
| GitHub PR | `registerGithubPrConnector({ token, owner, repo })` |
| CMS | `registerCmsConnector({ url, token?, type? })` |

## Governance & migration

Mark tokens with `$version`, `deprecated`, and `replacedBy`
(`token-to-css govern tokens.json --version 1.2.0 --deprecate color.old
--replaced-by color.primary`); `lint` warns when a live token references a
deprecated one.

**Impact-aware codemods.** `migrate` walks the provenance graph so a rename
knows its blast radius:

```bash
token-to-css migrate tokens.json --from color.primary --to color.brand.primary --codemod ./app
token-to-css migrate tokens.json --deprecated --codemod ./app
```

## Federation

**One org.** Compose team trees via a manifest (higher `priority` wins):

```json
{
  "name": "acme-design-system",
  "teams": {
    "core":    { "path": "./packages/core/tokens.json", "priority": 0 },
    "product": { "path": "./packages/product/tokens.json", "priority": 1 }
  }
}
```

```bash
token-to-css federate org.manifest.json -o merged.css
token-to-css federate org.manifest.json --lint      # lint every team
token-to-css federate org.manifest.json --team core # one team's tree
```

**Across orgs (v11).** The unit of sharing becomes a release, not a file:

- **Published packages.** Teams reference a package + semver range instead of
  a path; `^2.0` picks the newest in-range release directory of
  `<version>.json` snapshots. Remote teams default to priority `-1`, so
  remote loses to local.

  ```json
  {
    "packages": { "@acme/tokens": "./registry/acme-tokens" },
    "teams": { "acme": { "org": "acme", "package": "@acme/tokens", "range": "^2.0" } }
  }
  ```

- **Cross-org lockfiles.** `federate fed.manifest.json --lock lock.json`
  fails a consumer pinned `^2.x` against a published 3.0 release, listing
  every affected usage.
- **Server relay.** Each org runs its own `serve`; peers link with
  `--relay <peer-url>` (repeatable). A remote change arrives as a *pending
  change-request* — never a direct write. Approving folds it into local
  source and re-broadcasts; declining leaves it untouched. Idempotent, so the
  mesh cannot loop.
- **Org trust.** `createOrgAuth` tokens carry `org` + scope; `serve --org acme`
  rejects foreign-org tokens with 403. Merged trees report per-token
  provenance (`resolveFederatedTree(...).origins`).
- **Lossless registries.** `mergeOrgRegistries` prefixes canonical names
  `org:team:canonical`, so two orgs that both have `color.primary` stay
  distinct and round-trips stay byte-for-byte.
- **Adoption rollup.** `federate fed.manifest.json --adopt ./consumers`
  prints one adoption score per org plus the combined score.

## Adoption engine

Scan consumer code for hardcoded token values (exact matches and OKLCH
nearest-neighbors), rewrite them, and track the score:

```bash
token-to-css adopt tokens.json ./src --report          # score + trend (--snapshots)
token-to-css adopt tokens.json ./src --fix             # rewrite to var(--token), idempotent
token-to-css federate org.manifest.json --adopt ./apps # per-team rollup
```

**MCP server.** `token-to-css mcp tokens.json` speaks JSON-RPC over stdio so
AI coding agents can list tokens, ask for a rename's blast radius, and open
change-requests *through governance* instead of editing token files raw.

## Versioned design system

```bash
token-to-css release v1.json v2.json --version 2.3.0  # classify diff → semver + changelog
token-to-css lock lockfile.json v1.json v2.json        # breaking-change alerts for consumers
token-to-css bisect color.primary --checkpoints ./cps  # find the change that flipped a value
```

A removal classifies major, a value change minor, an addition patch. Consumer
lockfiles (`{ range, uses }`) fail CI listing every affected usage.

## Library use

```js
import { convert, convertToMap, parseLocated } from "token-to-css";

const css = convert(tokens, { format: "scss", modes: ["dark"] });

const { tree, loc } = parseLocated(fileText, "tokens.json");
const { css, map } = convertToMap(tree, loc, { format: "css" }); // + Source Map v3
```

`convert` options: `format`, `selector`, `preset`, `modes`, `brand`,
`resolve`, `reduce`, `strict`, `sourceComments`, `registry`, `map`, and W3C
`$value` input (auto-detected). The full surface — `flattenTokens`,
`resolveReferences`, `lintTokens`, `buildKit`, `reverse`, `createTokenServer`,
federation, governance, adoption, release — is exported from the root and
typed in `src/index.d.ts`.

## Packages (v11.5 split)

The batteries-included `token-to-css` meta-package re-exports everything, so
existing imports keep working. For slimmer installs, the compiler and the
connector hub ship separately:

| Package                        | Use it for                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| `token-to-css`                 | Everything: compiler + serve/editor/MCP/relay/adoption + connectors (meta) |
| `@token-to-css/core`           | Compiler only — `convert`, references, colors, registry, reverse, lint, migrate, federation, release. Zero plugin deps, no serve/editor code. |
| `@token-to-css/connectors`     | The connector hub SDK + Figma/Storybook/GitHub/CMS connectors (depends only on `@token-to-css/core`) |

```bash
npm install @token-to-css/core          # just the compiler
npm install @token-to-css/connectors    # + the connector hub
```

```js
import { convert } from "@token-to-css/core";
import { registerGithubPrConnector } from "@token-to-css/connectors";
```

## Plugins

```js
import { registerFunction, registerFormat, registerPlugin } from "token-to-css";

registerFunction("contrast", (args) => (args[0].value > args[1].value ? "dark" : "light"));
registerFormat("myfmt", (flat, opts) =>
  Object.entries(flat).map(([k, v]) => `${k}: ${v};`).join("\n")
);

// or bundle both:
registerPlugin({ name: "acme", functions: { /* ... */ }, formats: { /* ... */ } });
```

Registered functions receive evaluated args (`{ kind: "num" | "str", value,
unit }`) and return a string; registered formats receive the flat
`name -> value` map.

## Stability & SemVer

`token-to-css` follows [Semantic Versioning](https://semver.org/):

- **CLI flags** are stable; removals/renames only in a major, with a
  deprecation period first.
- **Library API** (`convert`, `convertToMap`, `flattenTokens`, `normalizeW3C`,
  `toCSS`/`toSCSS`/`toBarefoot`/`toCSSModules`, `resolveReferences`,
  `registerFunction`/`registerFormat`/`registerPlugin`/`registerConnector`,
  `reverse`, `lintTokens`, `buildKit*`, `serve` helpers, and the TypeScript
  types) is part of the supported contract.
- **Output shape** — variable naming, selectors, Source Map v3 — is stable;
  new formats are added in minors and never change existing ones.
- Node 20+. Tested on Node 20 and 22.

See [CHANGELOG.md](./CHANGELOG.md) for release notes and
[MIGRATION.md](./MIGRATION.md) for upgrade guidance.

## Tests

```bash
npm test        # 256 tests, node --test
```
