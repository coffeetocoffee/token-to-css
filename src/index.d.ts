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
  | "report";

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
