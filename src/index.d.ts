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
  | "ts"
  | "js";

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

export function reverse(css: string, options?: { barefoot?: boolean }): Tokens;
export function reverseStyleDictionary(sd: unknown): Tokens;

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
