export type TokenValue = string | number | boolean;
export interface TokenGroup {
  [key: string]: TokenValue | TokenGroup;
}
export type Tokens = TokenGroup;

export type Format =
  | "css"
  | "scss"
  | "barefoot"
  | "css-modules"
  | "json"
  | "tailwind"
  | "style-dictionary"
  | "schema"
  | "report"
  | "docs"
  | "provenance"
  | "ts"
  | "js"
  | "figma"
  | "storybook"
  | "github"
  | "cms";

export interface ConvertOptions {
  format?: Format;
  theme?: string;
  selector?: string;
  map?: Record<string, string>;
  resolve?: boolean;
  reduce?: boolean;
  validate?: boolean;
  sourceComments?: boolean;
  preset?: "tailwind" | "open-props";
  modes?: string[];
  brands?: string[];
  brand?: string;
  strict?: boolean;
  /** Emit/consume a canonical name registry so round-trips are lossless. */
  registry?: boolean | { canonicalOf(path: string[]): string; pathOf(canonical: string): string[] | null };
}

export function flattenTokens(
  input: Tokens,
  prefix?: string[]
): Record<string, string>;

export function resolveReferences(tokens: Tokens): Tokens;

export function normalizeW3C(input: Tokens): Tokens;

export function applyMap(
  flat: Record<string, string>,
  mapObj?: Record<string, string>
): Record<string, string>;

export function toCSS(
  flat: Record<string, string>,
  options?: { selector?: string; sourceComments?: boolean }
): string;

export function toSCSS(flat: Record<string, string>): string;

export function toCSSModules(flat: Record<string, string>): string;

export function toBarefoot(
  flat: Record<string, string>,
  options?: ConvertOptions
): string;

export function convert(tokens: Tokens, options?: ConvertOptions): string;

export interface TokenLocation {
  file: string;
  line: number;
}

export interface SourceMapV3 {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export function buildSourceMap(
  css: string,
  locations: Record<string, TokenLocation>,
  options?: {
    format?: Format;
    outputFile?: string;
    sourcesContent?: Record<string, string>;
    customMap?: Record<string, string>;
  }
): SourceMapV3;

export function convertToMap(
  tree: Tokens,
  locations: Record<string, TokenLocation>,
  options?: ConvertOptions & {
    outputFile?: string;
    sourcesContent?: Record<string, string>;
  }
): { css: string; map: SourceMapV3 };

export class TokenValidationError extends Error {
  constructor(message: string);
}

export function validateTokens(tokens: Tokens): true;

export interface TokenDiff {
  added: Record<string, string>;
  removed: Record<string, string>;
  changed: Record<string, { from: string; to: string }>;
}

export function diffTokens(a: Tokens, b: Tokens): TokenDiff;

export interface Plugin {
  name?: string;
  functions?: Record<string, (args: any[], ctx: any) => string>;
  formats?: Record<string, (flat: Record<string, string>, opts: any) => string>;
}

export function registerFunction(name: string, fn: (args: any[], ctx: any) => string): void;
export function registerFormat(name: string, fn: (flat: Record<string, string>, opts: any) => string): void;
export function registerPlugin(plugin: Plugin): Plugin;

export { parseLocated } from "./locate.js";
export type { TokenLocation } from "./locate.js";

export interface LintIssue {
  rule: string;
  message: string;
  path: string | null;
  severity: "error" | "warning";
}

export interface LintResult {
  issues: LintIssue[];
  errors: number;
  warnings: number;
}

export function lintTokens(tokens: Tokens, options?: { noUnused?: boolean; noDuplicates?: boolean }): LintResult;
export function checkContract(tokens: Tokens, schema: object): true;

export interface KitResult {
  css: string;
  js: string;
  html: string;
  ts: string;
  jsBindings: string;
  modes: string[];
  brands: string[];
  flat: Record<string, string>;
  names: string[];
}

export function splitThemes(tokens: Tokens): { base: Tokens; modes: Record<string, Tokens>; brands: Record<string, Tokens> };
export function buildKitCSS(tokens: Tokens, options?: ConvertOptions & { brands?: string[] }): { css: string; modes: string[]; brands: string[] };
export const THEME_JS: string;
export function buildThemeJS(): string;
export function buildBindings(tokens: Tokens, options?: ConvertOptions): { ts: string; js: string; flat: Record<string, string>; names: string[] };
export function buildPreviewHTML(tokens: Tokens, options?: ConvertOptions & { title?: string }): string;
export function buildKit(tokens: Tokens, options?: ConvertOptions & { title?: string; brands?: string[] }): KitResult;
export function buildDocsSite(tokens: Tokens, options?: ConvertOptions & { title?: string }): string;
export function buildExplorerHTML(tokens: Tokens, options?: ConvertOptions & { files?: { name: string }[] }): string;
export function buildProvenance(tokens: Tokens, options?: ConvertOptions & { title?: string }): string;

export function reverse(css: string, options?: { barefoot?: boolean; registry?: { pathOf(canonical: string): string[] | null } }): Tokens;
export function reverseStyleDictionary(sd: unknown): Tokens;

// --- v5.0: Token Server mesh ---

export interface NameRegistry {
  canonicalOf(path: string[]): string;
  pathOf(canonical: string): string[] | null;
  has(canonical: string): boolean;
  toJSON(): { version: number; names: { path: string; canonical: string }[] };
}

export function buildNameRegistry(tokens: Tokens, options?: { resolve?: boolean }): NameRegistry;
export function registryFromJSON(json: { names: { path: string; canonical: string }[] }): NameRegistry;
export function setByPath(node: Tokens, path: string[], value: unknown): void;
export function getByPath(node: Tokens, path: string[]): unknown;

export function buildClientJS(options?: { streamUrl?: string; name?: string }): string;

export interface TokenServer extends import("node:http").Server {
  broadcast(event: { type: string; tree?: Tokens; [k: string]: unknown }): void;
  setTokens(tree: Tokens): void;
  snapshotTree(): Tokens;
  closeAll(): void;
  /** v11.0: this server's org id (when created with the `org` option). */
  org: string | null;
  getSourceTree(): Tokens;
  /** v11.0: relay a peer org's current tree in as a pending change-request. */
  relay(peerUrl: string, options?: { token?: string | null; fetchImpl?: typeof fetch }): Promise<unknown>;
}

export function createTokenServer(options?: {
  tokensPath?: string;
  tokens?: Tokens;
  port?: number;
  watch?: boolean;
  playground?: boolean;
  editor?: boolean;
  registry?: boolean;
  streamUrl?: string;
  /** v11.0 org rooms & trust: this server's org id. */
  org?: string | null;
  auth?:
    | ((token: string, org?: string | null) => "read" | "write" | null)
    | Record<string, "read" | "write">;
  approve?: boolean;
  channels?: { canary?: Tokens };
}): TokenServer;

// --- v10.5: Visual Token Editor ---

export interface EditError {
  code: "empty-value" | "unknown-ref" | "bad-color" | "bad-rename" | "commit-failed" | "resolve-failed" | "bad-request";
  message?: string;
  ref?: string;
  valid?: string[];
}

export interface EditCommitChange {
  type: "value" | "rename";
  path?: string;
  from?: string | null;
  to?: string | null;
  scope: string;
  override?: boolean;
  creates?: boolean;
  operations?: number;
}

export interface TokenEdit {
  path?: string;
  value?: string;
  mode?: string;
  brand?: string;
  rename?: { from: string; to: string };
  confirmed?: boolean;
}

export interface EditPreview {
  ok: boolean;
  errors: EditError[];
  changed: EditCommitChange | null;
  diff: { added: Record<string, string>; removed: Record<string, string>; changed: Record<string, { from: string; to: string }> };
  verdict: { bump: "major" | "minor" | "patch" | "none"; removed: string[]; changed: string[]; added: string[] };
  blocked: boolean;
  impact: { direct: string[]; transitive: string[]; deprecated: boolean; replacedBy: string | null; value: string } | null;
  codemod: object | null;
}

export function validateEditValue(value: string, tree: Tokens): EditError[];
export function buildEditCommit(source: Tokens, edit: TokenEdit): { source: Tokens; changed: EditCommitChange };
export function editImpact(source: Tokens, path: string): EditPreview["impact"];
export function previewEdit(source: Tokens, edit: TokenEdit): EditPreview;
export function buildEditorHTML(tokens: Tokens, options?: { editable?: boolean; canary?: boolean; auth?: boolean }): string;

export function resolveTree(tokens: Tokens, options?: { mode?: string; brand?: string }): Tokens;

export function registerFigmaConnector(options?: {
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
  token?: string;
  fileKey?: string;
}): {
  push(tree: Tokens): Promise<unknown>;
  pull(): Promise<Tokens>;
  tokensToFigmaVariables(tree: Tokens): unknown;
  figmaVariablesToTokens(doc: unknown): Tokens;
};
export function tokensToFigmaVariables(tokens: Tokens, options?: { collection?: string; mode?: string }): unknown;
export function figmaVariablesToTokens(doc: unknown): Tokens;

// --- v8.0: Universal Connector Hub ---

export interface Connector {
  name: string;
  pull(ctx?: unknown): Promise<Tokens>;
  push(tree: Tokens, ctx?: unknown): Promise<unknown>;
  formats?: Record<string, (flat: Record<string, string>, opts: any) => string>;
}

export function registerConnector(connector: Connector): Connector;
export function getConnector(name: string): Connector | undefined;
export function listConnectors(): string[];
export function connectorPull(name: string, ctx?: unknown): Promise<Tokens>;
export function connectorPush(name: string, tree: Tokens, ctx?: unknown): Promise<unknown>;
export function toTransportTree(tokens: Tokens): Tokens;

export function registerStorybookConnector(options?: {
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
  url?: string;
  token?: string;
}): {
  pull(): Promise<Tokens>;
  push(tree: Tokens): Promise<unknown>;
  tokensToStorybookTheme(tree: Tokens): unknown;
  storybookThemeToTokens(doc: unknown): Tokens;
};
export function tokensToStorybookTheme(tokens: Tokens): unknown;
export function storybookThemeToTokens(doc: unknown): Tokens;

export function registerGithubPrConnector(options?: {
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
  token?: string;
  owner?: string;
  repo?: string;
  base?: string;
  path?: string;
  branchPrefix?: string;
}): {
  pull(): Promise<Tokens>;
  push(tree: Tokens): Promise<unknown>;
  tokensToGithubFiles(tree: Tokens, options?: { path?: string }): Record<string, string>;
  githubFilesToTokens(files: Record<string, string>, options?: { path?: string }): Tokens;
};
export function tokensToGithubFiles(tokens: Tokens, options?: { path?: string }): Record<string, string>;
export function githubFilesToTokens(files: Record<string, string>, options?: { path?: string }): Tokens;

export function registerCmsConnector(options?: {
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
  url?: string;
  token?: string;
  type?: string;
}): {
  pull(): Promise<Tokens>;
  push(tree: Tokens): Promise<unknown>;
  tokensToCmsEntries(tree: Tokens): Array<{ id: string; fields: { value: unknown; type: string; path: string } }>;
  cmsEntriesToTokens(entries: Array<{ id?: string; fields?: { value: unknown; type?: string; path?: string } }>): Tokens;
};
export function tokensToCmsEntries(tokens: Tokens): Array<{ id: string; fields: { value: unknown; type: string; path: string } }>;
export function cmsEntriesToTokens(entries: Array<{ id?: string; fields?: { value: unknown; type?: string; path?: string } }>): Tokens;

/**
 * Experimental: the `sync` surface (reverse-merge + drift) may change in a
 * minor release without a major bump while it bakes.
 */
export interface SyncResult {
  source: Tokens;
  changed: string[];
  skipped: string[];
}
export function applyReversedIntoSource(source: Tokens, reversed: Tokens): SyncResult;
export function computeDrift(source: Tokens, reversed: Tokens): Record<
  string,
  { added: Record<string, string>; changed: Record<string, { from: string; to: string }> }
>;
export function canSetPath(node: Tokens, flatName: string): boolean;

// --- v7.0: Governance, Migration & Federation ---

export interface DeprecationInfo {
  path: string;
  replacedBy: string | null;
  value: unknown;
}

export interface ChangeRequest {
  id: string;
  status: "pending" | "approved" | "rejected";
  author: string;
  reason: string;
  created: string;
  current: Tokens;
  proposed: Tokens;
  approved?: string;
  approver?: string;
  rejected?: string;
  rejectedBy?: string;
  rejectionReason?: string;
}

export function addVersionMarkers(tokens: Tokens, version: string): Tokens;
export function getDeprecations(tokens: Tokens): DeprecationInfo[];
export function createChangeRequest(current: Tokens, proposed: Tokens, options?: { author?: string; reason?: string }): ChangeRequest;
export function approveChangeRequest(cr: ChangeRequest, options?: { approver?: string }): ChangeRequest;
export function rejectChangeRequest(cr: ChangeRequest, reason?: string, options?: { rejectedBy?: string }): ChangeRequest;
export function applyChangeRequest(source: Tokens, cr: ChangeRequest): { tree: Tokens; cr: ChangeRequest };

export interface ImpactGraph {
  [tokenPath: string]: string[];
}

export interface CodemodOperation {
  type: "rename" | "update-ref";
  from?: string;
  to?: string;
  path?: string;
  oldRef?: string;
  newRef?: string;
}

export interface Codemod {
  version: string;
  operations: CodemodOperation[];
  impact: { direct: number; transitive: number };
}

export function getImpactGraph(tokens: Tokens): ImpactGraph;
export function getTransitiveDependents(tokens: Tokens, tokenPath: string): string[];
export function generateCodemod(tokens: Tokens, options: { from: string; to: string }): Codemod;
export function applyCodemod(tokens: Tokens, codemod: Codemod): { tree: Tokens; changes: Array<{ type: string; from?: string; to?: string; path?: string }> };
export function generateCSSCodemod(css: string, registry: NameRegistry | null, options: { from: string; to: string }): { version: string; type: string; operations: Array<{ type: string; find: string; replace: string }> };

export interface OrgManifestTeam {
  path?: string;
  /** v11.0: remote package team. */
  org?: string;
  package?: string;
  range?: string;
  priority: number;
  overrides: string[];
}

export interface OrgManifest {
  name: string;
  version: string;
  teams: Record<string, OrgManifestTeam>;
  /** v11.0: package name -> directory of `<version>.json` release snapshots. */
  packages?: Record<string, string>;
  overrides: Record<string, { extends: string; strategy?: string }>;
}

export function buildOrgManifest(manifestPath: string): OrgManifest;
export function validateManifest(manifest: object, basePath?: string): OrgManifest;
export function resolveOrgTree(manifest: OrgManifest): {
  merged: Tokens;
  teamTrees: Record<string, Tokens>;
  origins: Record<string, { org: string | null; team: string }>;
  resolvedPackages: Record<string, { name: string; version: string }>;
};
export function lintOrg(manifest: OrgManifest, contract?: object): Record<string, { path: string; lint?: LintResult; contract?: true; error?: string }>;

// --- v11.0: Cross-org Federation ---

export function listPackageVersions(packagesDir: string, packageName?: string): string[];
export function resolvePackage(ref: string | { package: string; range?: string }, options?: { packages?: Record<string, string>; registryDir?: string }): { name: string; version: string; tree: Tokens; path: string };

export interface FederatedRegistry {
  orgs: Set<string>;
  canonicalOf(orgOrPath: string[] | string, teamOrPath?: string[] | string, maybePath?: string[]): string | null;
  pathOf(canonical: string): string[] | null;
  ownerOf(canonical: string): { org: string; team: string } | null;
  has(canonical: string): boolean;
  toJSON(): { version: number; names: { org: string; team: string; path: string; canonical: string }[] };
}

export function mergeOrgRegistries(orgRegistries: Record<string, Record<string, NameRegistry> | NameRegistry>): FederatedRegistry;

export interface FederatedManifest {
  name: string;
  version: string;
  orgs: Record<string, OrgManifest>;
}

export function validateFederatedManifest(manifest: object, basePath?: string): FederatedManifest;
export function buildFederatedManifest(manifestPath: string): FederatedManifest;
export function resolveFederatedTree(fedManifest: FederatedManifest): {
  merged: Tokens;
  orgTrees: Record<string, ReturnType<typeof resolveOrgTree>>;
  origins: Record<string, { org: string; team: string }>;
};

export interface CrossOrgLockfile extends ConsumerLockfile {
  package: string;
  version?: string;
}

export function analyzeCrossOrgLock(lock: CrossOrgLockfile, registryDir: string, options?: { nextVersion?: string }): {
  package: string;
  prevVersion: string;
  nextVersion: string;
  inRange: boolean;
  ok: boolean;
  breaking: LockfileAlert[];
  range: string;
  version: string;
};

export interface MergedRegistry {
  canonicalOf(path: string[]): string | null;
  pathOf(canonical: string): { team: string; path: string[] } | null;
  has(canonical: string): boolean;
  toJSON(): { version: number; names: { team: string; path: string; canonical: string }[] };
}

export function mergeRegistries(registries: Record<string, NameRegistry>): MergedRegistry;

export type NamespacedAuthResolver = (token: string, team?: string) => "read" | "write" | null;
export function createNamespacedAuth(authConfig: { tokens: Record<string, { scope: string; teams: string[] }> }): NamespacedAuthResolver;
export function createFlatNamespacedAuth(flatMap: Record<string, string>): NamespacedAuthResolver;
export function createNamespacedMiddleware(authConfig: { tokens: Record<string, { scope: string; teams: string[] }> }, allowedTeams?: string[]): NamespacedAuthResolver;

// --- v11.0: Org rooms & trust ---

export type OrgAuthResolver = (token: string, org?: string | null, team?: string | null) => "read" | "write" | null;
export function createOrgAuth(authConfig: { tokens: Record<string, { scope: string; org?: string; teams?: string[] }> }): OrgAuthResolver;
export function orgRoomKey(org: string, team?: string | null): string;

// --- v11.0: Server-to-server relay ---

export function relayChange(options: { fromUrl: string; toUrl: string; token?: string | null; origin?: string | null; fetchImpl?: typeof fetch }): Promise<{ status: number; ok?: boolean; noop?: boolean; pending?: boolean; cr?: { id: string; status: string; origin: string | null } }>;
export function attachOrgRelay(options: { selfUrl: string; peerUrls: string[]; token?: string | null; origin?: string | null; fetchImpl?: typeof fetch; getCurrentTree?: () => Tokens | null }): { stop(): void };
export function consumeSSE(url: string, onEvent: (event: unknown) => void, options?: { signal?: AbortSignal | null; fetchImpl?: typeof fetch }): { stop(): void };
export function handleRelayPost(serverState: { sourceTree: Tokens; changeRequests: unknown[]; broadcast: (event: unknown) => void }, origin: string | null, tree: Tokens): { ok: boolean; noop?: boolean; pending?: boolean; cr?: { id: string; status: string; origin: string | null } };

// --- v9.0: The Adoption Engine ---

export interface ConsumerFinding {
  file: string;
  line: number;
  column: number;
  value: string;
  kind: "color" | "dimension";
  variable?: string;
  path?: string | null;
  exact: boolean;
  distance?: number;
}

export interface ConsumerLintResult {
  findings: ConsumerFinding[];
  errors: number;
  warnings: number;
  summary: { total: number; exact: number; nearest: number };
}

export interface ConsumerSource {
  file: string;
  text: string;
}

export function buildValueIndex(tokens: Tokens, options?: { registry?: NameRegistry | null; maxDistance?: number }): {
  colorIndex: Array<{ variable: string; value: string; oklch: { L: number; C: number; H: number; a: number }; path: string }>;
  valueIndex: Map<string, string>;
};

export function scanSource(text: string): { literals: Array<{ value: string; index: number; kind: string; line: number; column: number }>; adopted: number };

export function lintConsumer(tokens: Tokens, sources: ConsumerSource[], options?: { registry?: NameRegistry | null; maxDistance?: number }): ConsumerLintResult;

export function applyConsumerCodemod(tokens: Tokens, sources: ConsumerSource[], options?: { registry?: NameRegistry | null; maxDistance?: number }): { results: Array<{ file: string; changes: number; text: string }>; totalChanges: number };

export interface AdoptionScore {
  score: number;
  adopted: number;
  hardcoded: number;
  total: number;
}

export function computeAdoptionScore(tokens: Tokens, sources: ConsumerSource[], options?: { registry?: NameRegistry | null; maxDistance?: number }): AdoptionScore;

export function storeSnapshot(path: string, info: AdoptionScore): Array<{ date: string } & AdoptionScore>;
export function loadSnapshots(path: string): Array<{ date: string } & AdoptionScore>;

export function computeOrgAdoption(manifest: OrgManifest, resolveOrgTreeFn: (m: OrgManifest) => { merged: Tokens; teamTrees: Record<string, Tokens> }, sourcesByTeam: Record<string, ConsumerSource[]>): { teams: Record<string, AdoptionScore>; org: AdoptionScore };

/** v11.0: cross-org adoption rollup. */
export function computeFederatedAdoption(orgTeamTrees: Record<string, Record<string, Tokens>>, sourcesByOrg: Record<string, Record<string, ConsumerSource[]>>): { orgs: Record<string, { teams: Record<string, AdoptionScore>; org: AdoptionScore }>; combined: AdoptionScore };

export interface McpContext {
  tokens: Tokens;
  serveUrl: string | null;
  changeRequests: unknown[];
}

export function createMcpContext(options?: { tokens?: Tokens; serveUrl?: string | null }): McpContext;
export function handleMcpMessage(message: unknown, ctx: McpContext): unknown;

// --- v10.0: The Versioned Design System ---

export type ReleaseBump = "none" | "patch" | "minor" | "major";

export interface ReleaseResult {
  bump: ReleaseBump;
  nextVersion: string;
  changelog: string;
  removed: string[];
  changed: string[];
  added: string[];
}

export function bumpVersion(version: string, bump: ReleaseBump): string;
export function classifyRelease(prevTokens: Tokens, nextTokens: Tokens): { bump: ReleaseBump; removed: string[]; changed: string[]; added: string[] };
export function generateChangelog(version: string, result: { removed: string[]; changed: string[]; added: string[] }, options?: { prevVersion?: string }): string;
export function release(prevTokens: Tokens, nextTokens: Tokens, options?: { version?: string }): ReleaseResult;
export function semverSatisfies(version: string, range: string): boolean;

export interface ConsumerLockfile {
  name?: string;
  range: string;
  uses: string[];
}

export interface LockfileAlert {
  path: string;
  type: "removed" | "changed";
  from?: string;
  to?: string;
}

export function analyzeLockfile(lock: ConsumerLockfile, prevTokens: Tokens, nextTokens: Tokens, nextVersion?: string | null): { inRange: boolean; ok: boolean; breaking: LockfileAlert[]; range: string; version: string | null };

export interface Checkpoint {
  id: string;
  label?: string;
  tree: Tokens;
}

export interface BisectResult {
  found: boolean;
  index?: number;
  id?: string;
  label?: string;
  from?: unknown;
  to?: unknown;
  prevId?: string;
  prevValue?: unknown;
}

export function bisectToken(checkpoints: Checkpoint[], tokenPath: string): BisectResult;
export function renderSideBySide(tokenPath: string, from: unknown, to: unknown): string;
