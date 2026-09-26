# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [17.0.0] - 2026-09-25

Eleven findings from a full static audit are fixed, and four zero-dependency
gates now guard the classes of defect that audit surfaced. **All 447 tests pass**
(363 → 447). Each gate is verified to *fail* on the thing it guards — a gate
that cannot fire is worse than none, which this release also documents having
shipped once and caught.

> **Version note:** this supersedes the `v16.0.0` git tag, which was pushed
> pointing at the `$expand` commit but whose `package.json` still declared
> `15.0.0` and was never published to npm. The `v16.0.0` tag is left untouched;
> this release carries both the `$expand` work below and the audit fixes. npm
> `latest` moves from `15.0.0` straight to `17.0.0`.

### Fixed — security

- **Prototype pollution via change-request payloads** (`packages/core/src/governance.js`).
  `applyChangeRequest` deep-merged a CR's attacker-supplied `proposed` tree with
  an unguarded `target[key] = {}` followed by recursion. Assigning a fresh `{}`
  to `__proto__` does not create a property — it *replaces the target's
  prototype* — so the recursive descent then wrote the attacker's leaves
  straight onto `Object.prototype` (verified: `{}.polluted === 9`). Reachable
  from an approved change-request, i.e. the agent-facing write path. The
  `deepMerge` in `merge.js` is guarded too, and both now copy whole-object
  values through a key-sanitising clone so an own `__proto__` key cannot ride
  into the output tree and flatten into a bogus token.
- **Non-constant-time auth comparison** (`src/serve.js`, `packages/core/src/namespaces.js`).
  Bearer tokens were looked up with a plain object index, which short-circuits
  on the first differing byte. New exported `timingSafeTokenLookup()` compares
  against every key with a length-normalised, branch-free accumulator (no early
  exit), and is now used by `serve`, `createNamespacedAuth` and `createOrgAuth`.
  As a side effect it also rejects `__proto__`/`constructor`/`prototype` as
  candidate tokens. `crypto.timingSafeEqual` was deliberately not used: it needs
  equal-length Buffers and would reintroduce a length oracle.

### Fixed

- **`rgb()`/`hsl()` accepted wrong arity silently** — `rgb(1,2)` produced an
  invalid colour instead of raising. Both now require exactly 3 arguments.
- **`asNumber` depended on a unit it did not return** — every caller re-read
  `.unit` off the original token, a refactor trap. Replaced by `asRatio()`,
  which normalises `%` in one place.
- **`$expand` emitted invalid CSS for a descending `fluid` range** — bounds were
  not ordered, so `max < min` produced `clamp(2rem, ..., 1rem)`, which is
  invalid and collapses to a constant, silently stopping the token from
  responding to the viewport. Bounds are now ordered; **ascending output is
  byte-identical** to before.
- **`$expand` errors were a plain `Error`, not `TokenValidationError`** —
  because expansion runs *before* validation, a malformed `$expand` was
  indistinguishable from a compiler bug. All 13 throw sites now raise
  `TokenValidationError`, so `instanceof` is a single reliable check.

### Changed

- **`ramp` with a numeric `steps` count now emits palette-style names.** A count
  used to produce `color.brand.0` … `color.brand.4`; it now produces `50`,
  `200`, `400`, `600`, `900`. This is user-visible: a spec using a numeric ramp
  count produces different names than before. Explicit name arrays are
  unaffected, and no such usage exists in the tree. (`scale`/`fluid` keep index
  names, where a bare count carries no scale meaning.)
- **`cross` products are capped at 4096 combinations per group.** Over the cap
  throws with the count and shape, e.g. `8000 combinations (a[20] x b[20] x
  c[20]) exceeds the limit of 4096; split it into smaller $expand groups` —
  instead of silently allocating until the build dies.
- **`cors: true` combined with `auth` now warns at startup** that any origin may
  read the token tree. The CORS headers themselves are unchanged and must stay
  wide: they are the mechanism that makes the hosted playground's cross-origin
  write path legal. (An earlier attempt at this fix narrowed them and broke a
  passing test — recorded in the audit report.)

### Added — verification gates (zero dependencies)

Each gate is proven to fire on its own failure class, not merely to pass:

- **`scripts/check-syntax.js`** (`npm run check:syntax`) — catches a file that
  does not parse, binary/control bytes in source (reporting the **first byte
  offset** plus `git checkout -- <file>`), and invalid UTF-8. This is the gate
  that would have caught the `src/playground.js` corruption — which took down
  all 363 tests at once — at commit time. Implementer note: `node --check
  <file>.js` is **not** a reliable gate, because Node infers module-vs-script
  from the nearest `package.json` and, without `"type": "module"`, parses as
  CommonJS and reports `export` syntax errors as exit 0. The script pipes
  through `--input-type=module --check` on stdin instead.
- **`scripts/install-hooks.js`** (`npm run hooks:install`) — opt-in pre-commit
  hook running the syntax gate on staged files. Local-only, refuses to clobber a
  foreign hook, no husky.
- **`scripts/check-declarations.js`** (`npm run check:declarations`) — compares
  each shipped `.d.ts` against its module both ways: every runtime export must
  be declared, every declared value must exist. It found real drift on first
  run: `deepMerge`, `mergeTokens` and `timingSafeTokenLookup` were live exports
  with no declaration; all three are now declared with real signatures.
- **`scripts/check-coverage.js`** (`npm run check:coverage`) — parses lcov from
  Node's built-in coverage and enforces a global floor plus per-file floors on
  the five highest-risk modules, reporting a critical module that no test even
  imports rather than skipping it. Measured: lines 83.5%, branches 78.2%,
  functions 84.7%.
- **`npm run verify`** runs syntax → declarations → tests → coverage, wired to
  `prepublishOnly` and to CI (a new `gates` job that additionally checks every
  **committed blob**, so a clean working tree cannot hide a bad commit).
- **`test/registry-property.test.js`** — the registry's "provably lossless"
  round-trip claim is now property-tested over 300 seeded random trees with a
  deliberately collision-prone segment pool, asserting
  `pathOf(canonicalOf(P)) === P` for every leaf. Non-vacuity verified against a
  known-lossy registry.
- **84 new tests** across `test/weakness-fixes.test.js` (18),
  `test/expand-hardening.test.js` (14), `test/hardening-7-9.test.js` (30),
  `test/registry-property.test.js` (5), `test/gates.test.js` (17).

### Documentation

- `.d.ts` drift is now **documented, not silently tolerated**: `ramp`'s
  `light`/`dark` fields are not read by the implementation (it reads
  `lightness`; passing `light` is silently ignored), and `fluid` `min`/`max`
  must be unit strings, not the bare numbers the README and types implied. Both
  carry NOTE comments on the exact fields. They were deliberately **not**
  reconciled in the runtime — renaming a field or accepting a bare number
  changes the public API and is a maintainer decision, not something to slip
  into a hardening pass.
- `README.md` documents the four gates and `npm run verify`.
- No linter was added: none exists in this project, every candidate is a
  dependency, and lint rules are style rather than a correctness gate. Flagged
  as a decision, not an oversight.

### Added — Token expansion generators (`$expand`)

Generate families of tokens at compile time from declarative patterns — zero deps, full round-trip support.

- **`$expand` meta-key**: annotate any token node with one of four generator specs; expanded output merges cleanly with existing structure and participates in refs/themes/modes like hand-written tokens.
- **ramp generator**: perceptual color scales using OKLCH; maps lightness linearly across steps, optional chroma scaling against a base token, named step keys (e.g., `100`, `200`, `500`).
- **scale generator**: geometric progressions for spacing/type scale; configurable base, ratio, steps array + unit (px/rem/em), produces flat numeric values or calc().
- **fluid generator**: viewport interpolation with clamp(); sets min/max values and viewport bounds (vwMin/vwMax) producing CSS `clamp(min, (max-min)*(100vw - vwMin)/(vwMax - vwMin) + min)` formulas.
- **cross generator**: cartesian products with placeholder substitution; define dimensions as arrays and templates with `{dimName}` placeholders; templates resolve to refs that downstream reference resolution honors.
- **Provenance tracking**: each generated token records path/name/kind/value/semver; returned as `{ generated: [...] }` from `convert()` and via CLI `--generators --as-json`.
- **CLI `--generators` flag**: expand-only mode outputs JSON with both expanded tree and provenance array; full build pipeline runs expansion before validation/refs/themes automatically.
- **Schema & lint support**: `$expand` allowed alongside `$value`/$type; validation skips expanded checks on nodes that contain `$expand`; error messages specify which generator failed and why.
- 14 new tests (`test/expand-generators.test.js`); suite went 349 → 363 at the
  time this work landed, and is **447** as of 17.0.0 (see above).

## [15.0.0] - 2026-09-18

### Added — AI-native token ops (v15)

Agents move from *querying* the mesh to proposing, migrating, and explaining
tokens through the same governed write scope a human editor uses. Every tool
lands in MCP chats and in the browser at once — the batch/migration machinery
rides the existing editor + serve routes.

- **Batch change-requests**: `previewBatchEdit` / `buildBatchCommit`
  (`src/editor.js`) sequence multi-token edits (a later edit may reference a
  token an earlier edit added), validate each against the running tree, and
  classify the whole batch once with `classifyRelease`. The MCP
  `create_batch_change_request` tool opens ONE change request for a multi-token
  proposal — with a `serveUrl` the proposed tree lands as a single pending CR
  (202 under `--approve`), approved or rejected as a unit.
- **Agent-authored migrations**: the MCP `create_migration_request` tool
  attaches the ready-to-run v7 codemod (rename + update-ref operations) to a
  rename CR, tagged `cr.migration`; governance gates the merge, the codemod
  migrates consumers.
- **MCP sampling tools**: `suggest_name` (kebab-clean names under the right
  group, collisions disambiguated with the name registry's own `-N` rule — the
  name the linter and registry accept) and `group_tokens` (moves tokens under a
  common parent as one codemod; `by` heuristics: value/kind/prefix).
- **Token search + provenance**: the MCP `search` tool (lexical semantic search
  over the tree — segment/variable/kind/value matching with a completeness
  bonus, zero-dep) and `explain` (provenance: resolved value, refs consumed,
  direct/transitive dependents, deprecation + `replacedBy`, per-mode/brand
  overrides, `$version`).
- **Serve parity**: `GET /explain?path=` serves the provenance payload;
  `POST /editor/preview` accepts an edit array (batch preview, classified once).
- New public library surface in `src/ai.js`: `suggestTokenName`,
  `proposeGrouping`, `groupTokens`, `searchTokens`, `explainToken` — all
  re-exported from the meta package, zero-dep and side-effect-free.
- MCP `serverInfo` version now reports the package version. 27 new tests in
  `test/v15.test.js`; full suite 342.

### Changed
- Bumped `@token-to-css/core` and `@token-to-css/connectors` to 15.0.0 in
  lockstep with the root package.

## [14.0.0] - 2026-09-17

### Added — the component layer (v14 breadth) + scale & observability (v13)

`Act 1 / v13` gives the mesh an SRE; `Act 2 / v14` emits the one thing `kit`
never did — **components**. Major bump: the VS Code extension is deleted
(MCP tools remain for AI agents), and `reverse` now folds Tailwind-mapped
var names back to token paths.

- **`kit --components`** (v14 flagship): opt-in themeable primitives —
  buttons (default/secondary/hover/disabled), inputs (focus/placeholder),
  cards (elevated/title), `:focus-visible` rings — generated from tokens plus
  the component contract (`getComponentContract`). Every themeable value is
  a `var()` reference, so a token edit restyles the primitives end-to-end;
  the output is plain CSS, lintable by the v9 consumer lint.
  `buildKit(tokens, { components: true })` returns it as `components`;
  the CLI writes `components.css`.
- **Tailwind v4 CSS-first round-trip** (v14): `reverse` auto-detects `@theme`
  blocks and inverts `TAILWIND_MAP` (`--color-foreground` → `color.text`),
  so `reverse(convert(tokens, { format: "tailwind" }))` round-trips token
  values. New explicit `reverseTailwind(css, options)`; kebab collisions
  keep the documented best-effort leaf-wins behavior.
- **Flutter / Compose connectors** (v14): `registerFlutterConnector` /
  `registerComposeConnector` on the v8 SDK (zero core changes) with
  `{ tokens, theme }` round-trips, `push`/`pull` adapters, and opt-in
  `flutter` (Dart `TokenColors`/`TokenValues` + `buildTokenTheme`) and
  `compose` (Kotlin `object TokenColors`) output formats.
- **`serve` under load** (v13): cached lazy language index + incremental
  `/completions` (<50ms warm on a 10k-token fixture), off-hot-path SSE
  fan-out for hundreds of subscribers.
- **`GET /metrics`** (v13): zero-dep Prometheus exposition — CR counts,
  pending-CR gauge, subscriber count, fold-latency histogram, token count,
  adoption-score gauge (`createMetrics`, `src/metrics.js`).
- **CR audit trail** (v13): change-requests persist to `<tokensPath>.crlog.json`
  (`--cr-log`) and reload on restart, so approval flows and bisect
  checkpoints survive.
- **Adoption dashboards** (v13): `federate --report` renders score trends as
  an HTML charts page (`buildAdoptionReport`).
- **Performance CI** (v13): `npm run bench` (`scripts/bench-v13.js`) guards
  the hot paths; `.github/workflows/bench.yml` runs it per PR.

### Removed — the VS Code extension is gone

- `packages/vscode`, its marketplace/VSIX pipeline (`vscode.yml`,
  `vsce`/`ovsx`), and all editor-client code are deleted and must never
  return. The thin-client protocol it spoke (`token-to-css mcp`:
  `token_info`/`completions`/`diagnostics`) is unchanged and exists for AI
  agents only. See MIGRATION.md ("From 12.x/13.x to 14.0").

Full suite: **315 tests** (306 → 315; new `test/v14.test.js`).

## [12.3.0] - 2026-09-06

### Added — editor parity (v7 lint squiggles, true inline editing, multi-root)

`Act 0 / v12.3` — the extension catches up with the web editor: governance
warnings surface where you type, tokens can be edited without leaving VS Code,
and multi-package workspaces stop being a one-token-file world.

- **v7 `deprecated-in-use` lint in the editor**: the MCP `diagnostics` tool now
  flags deprecated token usage — `{deprecated.ref}` in token files and
  `var(--deprecated)` in consumer CSS/SCSS — each squiggle carrying the
  `replacedBy` migration and a one-click quick-fix that swaps in the
  replacement (bare dotted path in token files, `--var` in CSS). Sources
  ending in `.json` are treated as token files (kind `tokens`); the
  hardcoded-value scan is skipped there, since token definitions are not
  consumer code. An explicit `kind: "consumer"` overrides the inference.
- **True inline editing**: a new `token-to-css.editToken` command (also linked
  from every token hover) runs hover → QuickPick (preset ±10% values or a
  custom input) → `POST /editor/preview` (the v10.5 diff-before-commit
  dry-run: validation, resolved diff, semver verdict, impact) → a governed
  `POST /tokens` commit — the identical pipeline the web editor drives, so
  `--approve` queues a 202 change request and read-only scopes stay 403.
  Requires `tokenToCss.serveUrl`. Pipeline helpers live in the pure
  `src/editing.js` (`editQuickItems`, `previewRequestBody`, `previewSummary`,
  `commitBody`), tested headless like the rest of the extension brain.
- **Multi-root + glob config**: `tokenToCss.tokensPath` accepts a glob (e.g.
  `packages/*/tokens.json`) resolved against every workspace folder — each
  match boots its own `token-to-css mcp` child; hovers, completions, and
  diagnostics route through the matching server. `json` files now get
  diagnostics and quick-fixes too. Zero-dep glob resolution lives in
  `src/workspace.js` (never walks `node_modules`/`.git`).

## [12.2.0] - 2026-09-06

### Added — the static playground (hosted, no server)

`Act 0 / v12.2` — the playground promoted to a genuinely hosted default:
a pasted `tokens.json` gets a working preview + editor with **no server
running**, and proposals flow through a configured write scope.

- **`token-to-css playground --static <dir>`**: emits a deployable site —
  `index.html` (paste flow + preview + editor) and `playground.js` (the
  browser client, a real file so it stays testable). A few KB total; deploys
  as-is to GitHub Pages or any static host. An optional input file pre-fills
  the paste box; `--serve-url` / `--token` seed the proposal config.
- **Browser-safe core**: `packages/core/src/federation.js` no longer
  statically imports `node:fs`/`node:path` — they load dynamically at the top
  of the module (Node resolves them; browsers fall back to string path
  helpers, and the file-reading federation APIs throw a clear
  "requires Node.js" error if called). Every function signature is unchanged;
  core is now importable in a browser via a CDN ESM build. A package test
  enforces the no-static-`node:` boundary across the core source tree.
- **Client-side v10.5 pipeline**: the static page validates edits (unknown
  `{ref}`s, unparseable colors), computes `diffTokens` + `classifyRelease`
  before commit, blocks majors behind a confirm, and renders token rows with
  color swatches from the resolved tree — all in the browser via the import
  map (`@token-to-css/core` → jsDelivr `+esm`, major-pinned).
- **`serve --cors`** (opt-in, `createTokenServer({ cors: true | origin })`):
  cross-origin browser clients can read `GET /tokens` and POST proposals —
  OPTIONS preflights are answered before the auth gate; the write scope is
  still enforced on every POST (403 read-only). This is how the static page
  proposes into a running mesh without being same-origin.
- **GitHub Pages deploy** (`.github/workflows/playground.yml`): builds the
  static site on every push to master and deploys it via the Pages workflow.
- No breaking changes. Full suite: **305 tests** (294 → 305).

## [12.1.0] - 2026-09-05

### Added — VS Code extension marketplace release

- `packages/vscode` is now a publishable, marketplace-listed extension:
  - `repository`, `galleryBanner`, and `keywords` metadata; bundled
    `LICENSE` + `CHANGELOG.md`; `.vscodeignore` keeps the VSIX lean.
  - CI (`vscode.yml`) builds the `.vsix` on every push/PR and, on a `v*` tag,
    publishes to the VS Code Marketplace + Open VSX. `@vscode/vsce` and `ovsx`
    run on demand in CI — neither is committed, so the extension stays
    zero-dep.
- No core changes; the compiler, server, and MCP surface are untouched. Root
  package remains `12.0.0` (the extension is versioned independently as
  `12.1.0`).
- Full suite: 294 tests still pass.

## [12.0.0] - 2026-09-05

### Added — VS Code Extension & Hosted Playground

`[~]` since v6.0; the editor comes to where developers already are.

- **VS Code extension** (`packages/vscode`, thin client over `token-to-css mcp`):
  - **Language backend**: spawns the installed CLI (`token-to-css mcp
    <tokens.json>`) as a child process and speaks the existing MCP tools — no
    new protocol, no bundled compiler. New `McpClient` (newline-delimited
    JSON-RPC 2.0 over stdio) + pure, editor-agnostic `providers.js`
    (`hoverAt`, `completionsAt`, `diagnosticsFor`, `quickFixFor`).
  - **Three new MCP tools** (`src/mcp.js`, riding the existing JSON-RPC
    surface): `token_info` (resolved value, color swatch hex, CSS variable,
    deprecation/`replacedBy`, transitive dependents), `completions`
    (`kind:"css"` → `--var` names for CSS/SCSS; `kind:"ref"` → `{dotted}` refs
    for token files; prefix-filtered, deprecation-tagged), and `diagnostics`
    (the v9 consumer lint as squiggles: hardcoded color/dimension literals that
    match — or nearly match, via OKLCH — a known token, each with a
    `use var(--token)` quick-fix).
  - **Hover + swatch**: `var(--color-primary)`, a `{token}` ref, or a raw hex
    that matches a token resolves to value + swatch + canonical variable;
    deprecated tokens render their migration path.
  - **Completion**: `--*` names in CSS/SCSS and `{dotted}` refs in token
    files, from the resolved tree (mode/brand-scoped overrides included).
  - **Diagnostics + quick-fix**: the v9 consumer lint as editor squiggles;
    a quick-fix applies `adopt --fix` semantics to the single squiggle
    (idempotent — the literal lands inside `var(...)`).
  - **Commands**: restart language server, open the v10.5 visual editor
    (`tokenToCss.serveUrl`), live theme preview webview (iframes the running
    serve's playground over `/events` — same mesh subscription).
  - The pure language brain is unit-tested without the `vscode` API
    (`packages/vscode/test/extension.test.js`, 11 tests, including an
    end-to-end spawn of the real CLI over stdio).
- **Hosted web playground** (`token-to-css playground`): the v5.1 shareable
  playground promoted to a hosted default. A landing hub accepts a pasted
  `tokens.json` (or a running `serve` URL + optional bearer token) and boots a
  live session — each session **is** a real Token Server
  (`createTokenServer({ playground: true, editor: true })` on an ephemeral
  port), so the v10.5 commit pipeline
  (`POST /editor/preview` → governed `POST /tokens`) is intact by
  construction. Sessions pointing at a remote `serve` mirror its tree and
  forward proposals to the remote write scope (with `serve --approve` they
  arrive as change requests / token PRs via the GitHub connector).
  - `createPlaygroundServer` / `buildLandingHTML` exported from the root
    package; `POST /session` + `POST /session/<id>/propose` routes.
- **Package surface**: new subpath exports `token-to-css/mcp.js` and
  `token-to-css/playground.js`; MCP `initialize` reports `12.0.0`.
- *Why minor:* no core protocol change — the extension rides the existing MCP
  tools, editor routes, and SSE stream; the marketplace listing and the hosted
  site are new distribution, not new contracts.

### Upgrade notes

- Fully backward-compatible. The three new MCP tools are additive;
  `tools/list` now advertises them. The extension ships as
  `packages/vscode` (workspace member; packaged separately for the
  marketplace — it is not part of the npm meta-package `files`).

## [11.5.0] - 2026-09-05

### Added — The Real Package Split

`[~]` since v6.0; the compiler now ships as its own dependency-free package.

- **`@token-to-css/core`**: the compiler surface (`convert`, `flattenTokens`,
  `resolveReferences`, `normalizeW3C`, references, colors, registry, reverse,
  lint, migrate, federation, release) moves to `packages/core` and publishes as
  a standalone npm package. Zero plugin deps — the package contains no
  `serve`/`editor`/`mcp`/`relay`/`connect`/connector file, and a package test
  scans the source tree to prove the boundary. Kits that only need the
  compiler install `@token-to-css/core` directly.
- **`@token-to-css/connectors`**: the v8 Universal Connector Hub SDK plus the
  Figma/Storybook/GitHub/CMS connectors move to `packages/connectors` and
  publish as an opt-in package depending only on `@token-to-css/core`.
- **Root stays batteries-included**: `token-to-css` becomes a meta-package —
  `src/index.js` re-exports `core` + `connectors` + the server/editor/MCP/
  relay/adoption layers, and every historical subpath
  (`token-to-css/schema.js`, `/connectors/*.js`, `/presets/*.js`, `/core.js`,
  …) resolves through a thin shim. **No import changes required** — the 1.0
  SemVer contract holds.
- **Per-package publishing**: the release workflow publishes `core` →
  `connectors` → meta in order, skipping any package whose version is already
  on npm (idempotent like the 0.3.0 rule).
- **Package-level tests**: `packages/core/test/core.test.js` (compiler surface,
  lossless registry round-trip, boundary scan) and
  `packages/connectors/test/connectors.test.js` (hub SDK, per-connector
  round-trips, core-only dependency scan). Full suite: 267 tests.

### Upgrade notes
- Import paths are unchanged. New installs that want only the compiler can use
  `npm install @token-to-css/core`; the meta package depends on both new
  packages automatically.

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

[Unreleased]: https://github.com/coffeetocoffee/token-to-css/compare/v17.0.0...HEAD
[17.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v15.0.0...v17.0.0
[15.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v14.0.0...v15.0.0
[14.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v12.3.0...v14.0.0
[12.3.0]: https://github.com/coffeetocoffee/token-to-css/compare/v12.2.0...v12.3.0
[12.2.0]: https://github.com/coffeetocoffee/token-to-css/compare/v12.1.0...v12.2.0
[12.1.0]: https://github.com/coffeetocoffee/token-to-css/compare/v12.0.0...v12.1.0
[12.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v11.5.0...v12.0.0
[11.5.0]: https://github.com/coffeetocoffee/token-to-css/compare/v11.0.0...v11.5.0
[11.0.0]: https://github.com/coffeetocoffee/token-to-css/compare/v10.5.0...v11.0.0
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
