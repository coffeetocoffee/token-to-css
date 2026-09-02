export type TokenValue = string | number | boolean;
export interface TokenGroup {
  [key: string]: TokenValue | TokenGroup;
}
export type Tokens = TokenGroup;

export type Format = "css" | "scss" | "barefoot";

export interface ConvertOptions {
  format?: Format;
  theme?: string;
  selector?: string;
  map?: Record<string, string>;
  resolve?: boolean;
  reduce?: boolean;
  validate?: boolean;
  sourceComments?: boolean;
}

export function flattenTokens(
  input: Tokens,
  prefix?: string[]
): Record<string, string>;

export function resolveReferences(tokens: Tokens): Tokens;

export function toCSS(
  flat: Record<string, string>,
  options?: { selector?: string }
): string;

export function toSCSS(flat: Record<string, string>): string;

export function toBarefoot(
  flat: Record<string, string>,
  options?: ConvertOptions
): string;

export function convert(tokens: Tokens, options?: ConvertOptions): string;

export class TokenValidationError extends Error {
  constructor(message: string);
}

export function validateTokens(tokens: Tokens): true;
