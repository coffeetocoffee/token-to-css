# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [11.0.0] - 2026-09-05

### Added — Cross-org Federation

The unit of sharing stops being a file and becomes a **release**: separate
orgs compose each other's *published, versioned* token packages into their own
mesh without merging source files.

- **Published token packages** (`src/federation.js`): a manifest team may
  reference a package + semver range instead of a local path —
  `{ org: "acme", package: "@acme/tokens", range: "^2.0" }` plus a `packages`
  map pointing at release directories holding one `<version>.json` snapshot
  per release (the v10 `snapshot`/`release` format). `resolvePackage` picks
  the newest in-range release; `listPackageVersions` lists them. Remote
  package teams default to priority `-1`, so **remote loses to local** under
  the v7 priority rules.
- **Cross-org lockfiles + breaking alerts**: `analyzeCrossOrgLock(lock,
  registryDir)` runs the v10 lockfile check against a published package — a
  consumer pinned `^2.x` fails a cross-org 3.0 release listing every affected
  usage. CLI: `federate <fed.manifest.json> --lock <lockfile.json>`.
- **Server-to-server relay** (`src/relay.js`): multiple `serve` instances (one
  per org) link into a mesh — `serve --relay <peer-url>` (repeatable;
  library: `attachOrgRelay`, one-shot `relayChange`, generic SSE helper
  `consumeSSE`). Each org's source stays **authoritative**: a remote change
  arrives as a pending **change-request** (`POST /relay`, tagged with the
  remote origin), never a direct write. Approving folds it into local source
  and re-broadcasts; declining leaves it untouched. Idempotent — a
  re-broadcast of a held (approved or pending) tree is a no-op, so the relay
  cannot loop. `serve` also gains `POST /change-requests/:id/approve` for
  in-memory (no `tokensPath`) servers.
- **Namespaced registries across orgs**: `mergeOrgRegistries({ org: { team:
  registry } })` grows the v7 registry prefix to **`org:team:canonical`**, so
  two orgs that both have `color.primary` keep distinct lossless names;
  `reverse` accepts `:`-bearing canonical names, making
  `reverse(convert(federatedTree, { registry }))` byte-for-byte lossless.
  `ownerOf(canonical)` returns `{ org, team }`.
- **Org rooms & trust**: `createOrgAuth` tokens carry `org` + scope +
  teams; `createTokenServer({ org })` makes org identity part of the auth
  gate (a foreign org's token is 403 — it can never mutate this org's source;
  unknown tokens stay 401). `resolveOrgTree`/`resolveFederatedTree` return an
  `origins` provenance map recording which **org introduced each merged
  value**. `orgRoomKey(org, team)` names the `(org, team)` rooms.
- **Cross-org adoption rollup**: `computeFederatedAdoption(orgTeamTrees,
  sourcesByOrg)` aggregates the v9 adoption score per org plus a combined
  score. CLI: `federate <fed.manifest.json> --adopt <dir>` scans
  `<dir>/<org>/<team>/` and prints per-org, per-team and combined scores.
- **Federated manifests**: `buildFederatedManifest` /
  `validateFederatedManifest` compose whole org manifests (inline or by path)
  under an `orgs` key; `resolveFederatedTree` resolves every org (v7 priority
  rules inside each org, manifest key order across orgs). CLI `federate`
  detects the `orgs` shape automatically and supports `--org <name>` to emit
  a single org's merged tree.

### Why major
Introduces the remote-manifest schema, the server-to-server relay protocol
(`POST /relay` + origin-tagged CRs), and the `org:team:canonical` registry
format — new public contracts with no minor-grade surface. No existing API
removed; `mergeRegistries` (v7) and all prior manifest shapes keep working.

## [10.5.0] - 2026-09-05

### Added — The Visual Token Editor

- **Editable explorer** (`src/editor.js`): `buildEditorHTML` renders the token
  explorer with inline, type-aware editors — a color picker (bound to the
  existing color engine), ±10% steppers for dimensions, and plain text for
  everything else. Deprecated tokens render their `replacedBy` path and prefill
  the edit with `{replacedBy}`. Served by `serve` at `GET /editor` (on by
  default; `serve --editor=false` disables).
- **Scoped editing (modes/brands)**: `buildEditCommit(source, edit)` applies a
  value edit to the right subtree — with `mode`/`brand` the write lands in
  `modes.<m>` / `brands.<b>` (flagged as a new `override` when the scope subtree
  has no such token yet), never silently in the base tree. W3C `$value` leaves
  are updated in place.
- **Reference-aware inputs**: `validateEditValue(value, tree)` validates every
  `{dotted.path}` reference (unknown refs are rejected with the valid token
  list offered) and rejects unparseable color literals.
- **Diff-before-commit**: `previewEdit(source, edit)` is the dry-run — the
  resolved `diffTokens` diff (`+added / -removed / ~changed`), the v10
  `classifyRelease` semver verdict, and `blocked: true` when the verdict is
  major (a removal) unless the edit is explicitly `confirmed`.
- **Governance-aware impact**: `editImpact(source, path)` reports direct +
  transitive dependents (v7 impact graph) and the token's deprecation state so
  the editor shows the blast radius before commit.
- **Codemod hand-off**: a rename preview carries the ready-to-run v7 codemod
  (rename + update-ref operations) and the CLI line
  `token-to-css migrate --from <path> --to <path> --codemod ./app`.
- **Editor server routes** (`src/serve.js`): `GET /editor` serves the editor;
  `POST /editor/preview` returns the dry-run payload. Commits reuse the
  existing `POST /tokens` write scope (403 for read-only tokens, 202 +
  change-request with `--approve`, `?channel=canary` for canary-first editing)
  — no new protocol.
- **Canary-first editing + live preview**: the editor's channel picker targets
  the v10 canary channel (stable subscribers see nothing until `POST /promote`);
  a draft CSS layer applies edited values to the preview pane on every
  keystroke, with the source file untouched until commit.
- CLI: `serve --editor[=false]` flag; `createTokenServer` accepts
  `editor: boolean`.
- 30 new tests (`test/v10.5.test.js`; 233 total).

## [10.0.0] - 2026-09-04

### Added — The Versioned Design System

- **Automated semantic releases** (`src/release.js`): `classifyRelease(prev, next)`
  maps a `diffTokens` result to a semver bump (removed → major, changed → minor,
  added → patch); `bumpVersion`, `generateChangelog`, and `release` produce the
  next version + a changelog section. CLI: `token-to-css release <prev> <next>
  [--version x.y.z] [--changelog <file>]`.
- **Consumer lockfiles + breaking-change alerts** (`src/release.js`):
  `analyzeLockfile({ range, uses }, prev, next, version)` fails a consumer pinned
  out of range and lists every affected usage. CLI: `token-to-css lock <lockfile>
  <prev> <next> [--version x.y.z]` (exit 1 on breaking).
- **Time travel / bisect** (`src/release.js`): `bisectToken(checkpoints, path)`
  walks an ordered checkpoint list to the single change that flipped a token value;
  `renderSideBySide` prints before/after. CLI: `token-to-css bisect <token.path>
  --checkpoints <dir>`.
- **Release channels** (`src/serve.js`): `serve` streams `canary` and `stable`
  channels — `GET /tokens?channel=canary`, `POST /tokens?channel=canary`,
  `GET /channels`, and `POST /promote` (canary → stable). SSE events carry a
  `channel` field so canary subscribers get a change before promotion while stable
  subscribers see nothing until `promote`. CLI: `token-to-css serve <tokens>
  --canary <file>`.
- New public exports: `release`, `classifyRelease`, `bumpVersion`,
  `generateChangelog`, `semverSatisfies`, `analyzeLockfile`, `bisectToken`,
  `renderSideBySide`.

## [9.0.0] - 2026-09-04

### Added — The Adoption Engine

- **Consumer lint** (`src/adopt.js`): `lintConsumer(tokens, sources)` scans app
  source (CSS/SCSS/TS/JS) for hardcoded values that match — or nearly match, via
  OKLCH nearest-distance in the color engine — a known token, suggesting the
  `var(--token)` to use. Exact and nearest matches are both reported.
- **Adoption codemods** (`src/adopt.js`): `applyConsumerCodemod(tokens, sources)`
  backs `token-to-css adopt ./app --fix`, rewriting hardcoded literals to
  `var(--token)`. Idempotent by construction (a second run reports 0 changes).
- **Adoption score** (`src/adopt.js`): `computeAdoptionScore` returns the
  adopted-percentage of a repo; `storeSnapshot` / `loadSnapshots` persist a trend,
  and `computeOrgAdoption` rolls up one score per team. `token-to-css adopt --report
  [--snapshots <file>]` prints the score + trend; `federate <m> --adopt <dir>`
  aggregates per-team scores.
- **MCP server** (`src/mcp.js`): `token-to-css mcp` exposes tokens, the impact
  graph, the adoption scan, and change-request creation as MCP tools (JSON-RPC over
  stdio, zero-dep). `create_change_request` points at a running `serve` so the CR
  appears in `GET /change-requests`.
- **Real package split**: `@token-to-css/stylelint` and `@token-to-css/eslint`
  ship as standalone packages that register purely through the public surface
  (`buildValueIndex` + `lintConsumer`), with zero plugin dependencies.
- New public exports: `buildValueIndex`, `lintConsumer`, `applyConsumerCodemod`,
  `computeAdoptionScore`, `storeSnapshot`, `loadSnapshots`, `computeOrgAdoption`,
  `scanSource`, `createMcpContext`, `handleMcpMessage`.

## [8.0.0] - 2026-09-03

### Added — Universal Connector Hub

- **Connector SDK** (`src/connect.js`): `registerConnector({ name, pull, push, formats? })`
  registers an external-system adapter; `getConnector(name)`, `listConnectors()`,
  `connectorPull`, and `connectorPush` look up and invoke it. A connector may also
  register output `formats` consumed by `convert(tokens, { format })`.
- **`serve` connector endpoints**: `GET /connectors` lists registered connectors;
  `POST /connectors/<name>/pull` pulls the external tree into the mesh;
  `POST /connectors/<name>/push` pushes the current mesh tree out. Mutating routes
  pass the POST write-scope gate when `--auth` is set. A connector registered via
  `registerConnector` round-trips a token change end-to-end through `serve` with
  zero core changes.
- **Storybook connector** (`src/connectors/storybook.js`): `registerStorybookConnector`,
  `tokensToStorybookTheme` / `storybookThemeToTokens` (pure, network-free round-trip),
  and `push`/`pull` adapters against a Storybook adapter endpoint. Registers the
  `storybook` output format.
- **GitHub PR connector** (`src/connectors/github.js`): `registerGithubPrConnector`,
  `tokensToGithubFiles` / `githubFilesToTokens`, and `push`/`pull` that open a PR with
  the updated token file. Registers the `github` output format.
- **CMS connector** (`src/connectors/cms.js`): `registerCmsConnector`,
  `tokensToCmsEntries` / `cmsEntriesToTokens` (Contentful/Sanity-style entries), and
  `push`/`pull` against a CMS REST endpoint. Registers the `cms` output format.
- CLI `-f` accepts `storybook`, `github`, and `cms`; the three built-in connectors
  self-register their output formats on CLI start.

### Why major

Adds the `registerConnector` SDK contract and three connectors; the SDK shape is part
of the public surface and may require a major to change. Connectors are experimental.

## [7.0.0] - 2026-09-03

### Added — Design System Governance & Federation

- **Token versioning & governance** (`src/governance.js`):
  - `addVersionMarkers(tokens, version)`: stamp `$version` on every leaf token.
  - `getDeprecations(tokens)`: collect all tokens with `deprecated: true`.
  - `createChangeRequest(current, proposed, { author, reason })`: create a change-request object.
  - `approveChangeRequest(cr)` / `rejectChangeRequest(cr, reason)`: CR lifecycle.
  - `applyChangeRequest(source, cr)`: apply approved CR to source tree.
  - New token schema fields (backward-compatible): `$version`, `deprecated`, `replacedBy`.

- **Migration codemods** (`src/migrate.js`):
  - `getImpactGraph(tokens)`: build reverse-dependency graph from token tree.
  - `getTransitiveDependents(tokens, tokenPath)`: get all transitive dependents.
  - `generateCodemod(tokens, { from, to })`: produce codemod for token rename.
  - `applyCodemod(tokens, codemod)`: apply codemod to token tree.
  - `generateCSSCodemod(css, registry, { from, to })`: CSS find/replace pairs.

- **Federation & org manifest** (`src/federation.js`):
  - `buildOrgManifest(manifestPath)`: parse and validate org manifest.
  - `validateManifest(manifest, basePath)`: validate manifest object.
  - `resolveOrgTree(manifest)`: compose multi-team trees into merged tree.
  - `lintOrg(manifest, contract)`: run lint across all teams.
  - `mergeRegistries(registries)`: merge canonical name registries with team prefixes.

- **Per-team namespaces** (`src/namespaces.js`):
  - `createNamespacedAuth(authConfig)`: team-scoped auth resolver.
  - `createFlatNamespacedAuth(flatMap)`: flat map to namespaced resolver.
  - `createNamespacedMiddleware(authConfig, allowedTeams)`: middleware for serve.

- **New CLI subcommands**:
  - `token-to-css migrate <input.json> --from <path> --to <path> [--codemod <dir>] [--dry-run]`
  - `token-to-css migrate <input.json> --deprecated [--codemod <dir>]`
  - `token-to-css federate <org.manifest.json> [-o <output>] [--lint] [--team <name>]`
  - `token-to-css govern <input.json> [--version <semver>] [--deprecate <path> --replaced-by <path>]`

- **New serve endpoints**:
  - `GET /change-requests`: list pending change requests.
  - `POST /change-requests/:id/approve`: approve a CR.
  - `POST /change-requests/:id/reject`: reject a CR.
  - `GET /teams/:team/tokens`: team-scoped token tree.
  - `POST /teams/:team/tokens`: write to team namespace.
  - `GET /teams/:team/events`: team-scoped SSE stream.
  - `GET /teams`: list all teams.
  - `--approve` flag: enable approval mode for `POST /tokens`.

- **Lint rules**:
  - `deprecated-in-use`: warn when non-deprecated token references deprecated token.

- **Provenance view**: shows deprecation warnings and migration paths.

### Why major

Introduces a policy/versioning surface, an org-manifest format, and the
namespace/room model. The codemod CLI and manifest schema are new public
contracts that may evolve within the 7.x line.

## [6.0.0] - 2026-09-03

### Added — Post-server hardening

- **Auth / scoping for `serve`** (`--auth <file>`): token-gated access. The auth
  file is a JSON map of `token -> "read" | "write"` (or `{ tokens: [{ token, scope }] }`).
  Every request needs `Authorization: Bearer <token>`; `GET` accepts read or write
  scope, `POST /tokens` requires **write** scope. A read-only token is rejected with
  `403` and the source file is never mutated; a missing/invalid token gets `401`.
  With no `--auth`, the server stays open (legacy behavior).
- **Built-in color spaces**: `oklch()`, `oklab()`, `lab()`, and `lch()` are now
  first-class color values and reference functions (registered alongside `rgb`/`hsl`).
  Tokens may be authored directly in OKLCH/Lab (`color.primary: "oklch(0.7 0.15 30)"`)
  and they resolve to sRGB; they also compose inside transforms
  (`lighten(oklch(0.6 0.1 250), 20%)`).
- **`--format provenance`** (and `buildProvenance`): a Wikipedia-style token page
  showing each token's resolved value, a swatch, and its reverse dependency graph
  ("used by") so you can see blast radius before editing.
- **Extra lint rule**: `empty-group` flags groups that contain no token leaves
  (dead branches that ship no CSS variables). Suppress with `lint --no-empty-groups`
  (or `{ noEmptyGroups: true }`).
- **Package-split foundation**: `src/core.js` freezes the plugin-free public
  surface a future `@token-to-css/core` would expose. Plugins (e.g. the Figma
  connector) depend only on that surface via `registerPlugin` / `registerFunction` /
  `registerFormat`, so `core` has zero plugin dependencies and each plugin can ship
  and install independently.

### Why major

Adds a server auth contract and new public outputs/API (`provenance`, color-space
functions, `core` entry). The `--auth` envelope (401/403 semantics) and the
`provenance` HTML shape are part of the 6.x public surface and may evolve within
the line before a v7.

## [5.0.0] - 2026-09-03

### Added — The Token Server (live design-system mesh)

- **`token-to-css serve <input.json>`**: a live service that turns the token file
  into a runtime source of truth for an entire org. REST API: `GET /tokens`
  (resolved tree), `GET /tokens?mode=dark&brand=x` (override applied),
  `GET /tokens/<dotted.path>` (single value), and `GET /tokens.names.json`
  (the canonical name registry). A streaming **SSE** channel at `GET /events`
  pushes the full tree the instant the file changes, a reverse-edit lands, or a
  connector pushes.
- **Generated client SDK** (`GET /tokens-client.js`): `TokenClient` subscribes to
  the SSE push channel, hot-swaps mode/brand via `data-*` attributes with zero
  rebuild, and exposes the same typed tree `kit` emits. Framework-agnostic and
  tiny (no React/DOM-only APIs). Also available from `buildClientJS()`.
- **Bidirectional write scope**: `POST /tokens` folds a submitted tree into
  `tokens.json` via `applyReversedIntoSource` and re-broadcasts to all
  subscribers. Idempotent — a no-op submission does not re-trigger a write loop.
  `serve` is `sync`'s two-way loop exposed over the network.
- **Canonical name registry** (`--registry`): the hard problem deferred from
  v4.0. Every token path gets a unique canonical flat name and the mapping is
  invertible, so `reverse(convert(tokens, { registry }))` reproduces the token
  tree **byte-for-byte even for kebab-colliding names** (e.g. `color.primary`
  leaf vs `color.primary.hover` nested). The registry is emitted as
  `tokens.names.json` alongside outputs (and consumed by `reverse --registry`);
  `sync` and `serve` stop reporting skipped kebab collisions.
- **Figma connector** (`registerFigmaConnector`, experimental): the third leg of
  interchange after CSS/SCSS and Style Dictionary. `tokensToFigmaVariables` /
  `figmaVariablesToTokens` round-trip, and the connector pushes/pulls via the
  Figma REST API when a `fetchImpl` is supplied. Registers an opt-in `figma`
  output format (`convert(tokens, { format: "figma" })`). No hard dependency on
  Figma's SDK — it is an adapter that plugs into the mesh.
- **Shareable playground** (`serve --playground`): hosts the kit preview over
  HTTP with a "propose change" action that POSTs back to the server write scope.
- New library exports: `createTokenServer`, `resolveTree`, `buildClientJS`,
  `buildNameRegistry`, `registryFromJSON`, `setByPath`, `getByPath`,
  `registerFigmaConnector`, `tokensToFigmaVariables`, `figmaVariablesToTokens`.

### Why major

Introduces a long-running server process, a generated client artifact/contract,
a canonical name registry, and a connector surface. The push-channel message
schema and the registry format are part of the public surface and may need a
major to change. (`sync` itself stays experimental in minors; `serve` +
connectors graduate it.)

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

[Unreleased]: https://github.com/coffeetocoffee/token-to-css/compare/v10.5.0...HEAD
[10.5.0]: https://github.com/coffeetocoffee/token-to-css/compare/v10.0.0...v10.5.0
[10.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v9.0.0...v10.0.0
[9.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v8.0.0...v9.0.0
[8.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v7.0.0...v8.0.0
[7.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v6.0.0...v7.0.0
[6.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v5.0.0...v6.0.0
[5.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v4.0.1...v5.0.0
[4.0.1]: https://github.com/coffeetocoffee/token-to-css/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v3.0.0...v4.0.0
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
