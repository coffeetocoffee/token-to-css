import { Tokens } from "./index.js";

export class TokenValidationError extends Error {
  constructor(message: string);
}

export const TOKEN_SCHEMA: object;

export function validateTokens(tokens: Tokens): true;
