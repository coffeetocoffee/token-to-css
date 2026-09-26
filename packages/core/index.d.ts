export type Tokens = any;

export interface ExpandGenerator {
  ramp?: {
    base?: string;
    /**
     * `steps` may be an explicit list of names, or a count. A count derives
     * conventional palette stop names (50, 100, 200, ... 900); a count larger
     * than the built-in table is spread evenly across 50..950.
     */
    steps: (string | number)[] | number;
    /**
     * NOTE: `light`/`dark` are NOT read by the implementation — it reads
     * `lightness`. Passed as `light`, the bounds are silently ignored and the
     * default [0.95, 0.25] is used. See the open drift item in the weakness
     * report before relying on this type.
     */
    light?: [number, number];
    dark?: [number, number];
    /** [lightest, darkest] OKLCH lightness bounds. Default [0.95, 0.25]. */
    lightness?: [number, number];
    chroma?: number;
  };
  scale?: {
    base: number;
    ratio?: number;
    steps: (string | number)[] | number;
    unit?: string;
  };
  fluid?: {
    property: string;
    /**
     * NOTE: `min`/`max` must be length STRINGS with a unit ("1rem", "16px"),
     * not bare numbers — a number throws. The `number` type below reflects the
     * shipped .d.ts, which is wrong; corrected here to match the code.
     */
    min: number | string;
    max: number | string;
    /** Required in practice: the implementation throws without it. */
    steps?: (string | number)[] | number;
    vwMin?: number;
    vwMax?: number;
  };
  cross: {
    /** Cartesian product; the product of all lengths is capped at 4096. */
    [dimension: string]: (string | number)[];
  };
  template?: Record<string, string>;
}

export interface GeneratedToken {
  path: string;
  name: string;
  kind: "ramp" | "scale" | "fluid" | "cross";
  value: string;
  provenance: string;
  semver: "patch" | "minor" | "major";
}

export interface ExpandResult {
  tokens: Tokens;
  generated: GeneratedToken[];
}

export function expandTokens(input: Tokens): ExpandResult;

export function convert(tokens: Tokens, options?: any): string;
export function convertToMap(tree: Tokens, locations: any, options?: any): { css: string; map: any };
export function flattenTokens(input: any, prefix?: any[], opts?: any): Record<string, string>;
export function normalizeW3C(input: any): any;
export function applyMap(flat: any, mapObj?: any): any;
export function toCSS(flat: any, options?: any): string;
export function toSCSS(flat: any, options?: any): string;
export function toCSSModules(flat: any, options?: any): string;
export function toBarefoot(flat: any, options?: any): string;
export function resolveReferences(tokens: any, options?: any): any;
export function registerFunction(name: string, fn: (...args: any[]) => any): void;
export function registerFormat(name: string, fn: (...args: any[]) => any): void;
export function registerPlugin(plugin: any): any;
export function validateTokens(tokens: any): boolean;
export class TokenValidationError extends Error {}
export function lintTokens(tokens: any, options?: any): any;
export function checkContract(tokens: any, contract: any): any;
export function buildKit(tokens: any, options?: any): any;
export function buildKitCSS(tokens: any, options?: any): string;
export function buildThemeJS(options?: any): string;
export function buildBindings(tokens: any, options?: any): { ts: string; js: string };
export function buildPreviewHTML(tokens: any, options?: any): string;
export function splitThemes(tree: any): any;
export const THEME_JS: string;
export function buildDocsSite(tokens: any, options?: any): string;
export function buildExplorerHTML(tokens: any, options?: any): string;
export function buildProvenance(tokens: any, options?: any): string;
export function reverse(css: string, options?: any): any;
export function reverseStyleDictionary(sd: any, options?: any): any;
export function reverseTailwind(css: string, options?: any): any;
export function buildComponentsCSS(tokens: any, options?: any): string;
export function getComponentContract(): { required: string[]; optional: string[] };
export const COMPONENT_PREFIX: string;
export const COMPONENT_TOKENS: string[];
export function applyReversedIntoSource(...args: any[]): any;
export function computeDrift(...args: any[]): any;
export function canSetPath(...args: any[]): any;
export function buildNameRegistry(tokens: any, options?: any): any;
export function registryFromJSON(json: any): any;
export function setByPath(obj: any, path: any[], value: any): void;
export function getByPath(obj: any, path: any[]): any;
export function mergeRegistries(...args: any[]): any;
export function parseLocated(input: any, source?: string): any;
export function buildClientJS(options?: any): string;
export function addVersionMarkers(tokens: any, semver: string): any;
export function getDeprecations(tokens: any): any;
export function createChangeRequest(...args: any[]): any;
export function approveChangeRequest(...args: any[]): any;
export function rejectChangeRequest(...args: any[]): any;
export function applyChangeRequest(...args: any[]): any;
export function getImpactGraph(tokens: any): any;
export function getTransitiveDependents(tokens: any, path: string): string[];
export function generateCodemod(tokens: any, opts: any): any;
export function applyCodemod(tree: any, codemod: any): any;
export function generateCSSCodemod(tokens: any, opts: any): any;
export function buildOrgManifest(...args: any[]): any;
export function validateManifest(...args: any[]): any;
export function resolveOrgTree(...args: any[]): any;
export function lintOrg(...args: any[]): any;
export function listPackageVersions(...args: any[]): any;
export function resolvePackage(...args: any[]): any;
export function mergeOrgRegistries(...args: any[]): any;
export function buildFederatedManifest(...args: any[]): any;
export function validateFederatedManifest(...args: any[]): any;
export function resolveFederatedTree(...args: any[]): any;
export function analyzeCrossOrgLock(...args: any[]): any;
export function createNamespacedAuth(...args: any[]): any;
export function createFlatNamespacedAuth(...args: any[]): any;
export function createNamespacedMiddleware(...args: any[]): any;
export function createOrgAuth(...args: any[]): any;
export function orgRoomKey(...args: any[]): any;
/**
 * Constant-time lookup of a candidate token in a `{ token: entry }` map.
 * Compares against every key with a length-normalised, branch-free accumulator
 * (no byte-position short-circuit, no early exit). Returns the matching entry,
 * or null for a non-string/empty/absent candidate. Also rejects `__proto__`,
 * `constructor` and `prototype` as candidate tokens.
 */
export function timingSafeTokenLookup<T = any>(
  tokenMap: Record<string, T>,
  candidate: unknown
): T | null;
export function bumpVersion(...args: any[]): any;
export function classifyRelease(...args: any[]): any;
export function generateChangelog(...args: any[]): any;
export function release(...args: any[]): any;
export function semverSatisfies(...args: any[]): any;
export function analyzeLockfile(...args: any[]): any;
export function bisectToken(...args: any[]): any;
export function renderSideBySide(...args: any[]): any;
export function diffTokens(a: any, b: any): any;
export function buildSourceMap(css: string, locations: any, options?: any): any;

/**
 * Recursively merge `source` into `target` (mutating and returning `target`).
 * Nested objects are merged; anything else replaces. Keys `__proto__`,
 * `constructor` and `prototype` are SKIPPED, and whole-object values are copied
 * through a key-sanitising clone, so an attacker-controlled tree cannot pollute
 * `Object.prototype` or smuggle an own `__proto__` key into the output.
 */
export function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Record<string, any>
): T;
/** Deep-merge `imports` in order, with `main` last so it wins. Returns a new object. */
export function mergeTokens(
  main: Record<string, any>,
  imports: Record<string, any>[]
): Record<string, any>;

export function parseColor(str: string): any;
export function formatColor(c: any): string;
export function mix(c1: any, c2: any, weight?: number): any;
export function withAlpha(c: any, a: number): any;
export function lighten(c: any, amount: number): any;
export function darken(c: any, amount: number): any;
export function oklabToRgb(...args: any[]): any;
export function oklchToRgb(...args: any[]): any;
export function labToRgb(...args: any[]): any;
export function rgbToOklch(c: any): any;
export function oklchDistance(a: any, b: any): number;

export const BAREFOOT_MAP: Record<string, string>;
export const TAILWIND_MAP: Record<string, string>;
export const OPENPROPS_MAP: Record<string, string>;
export function mapToBarefoot(flat: any, map?: any): any;
