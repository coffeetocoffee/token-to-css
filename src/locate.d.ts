import { Tokens } from "./index.js";

export interface TokenLocation {
  file: string;
  line: number;
}

export function parseLocated(
  text: string,
  filename: string
): { tree: Tokens; loc: Record<string, TokenLocation> };
