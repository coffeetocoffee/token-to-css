import { resolveReferences } from "./references.js";

export const TOKEN_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Design Tokens",
  description:
    "Nested design tokens. Groups are objects; leaves are strings, numbers, or booleans. String leaves may reference other tokens with {dotted.path} and may contain spaced arithmetic (e.g. \"{space.md} * 2\") which is emitted as calc().",
  type: "object",
  additionalProperties: { $ref: "#/$defs/tokenOrGroup" },
  $defs: {
    tokenOrGroup: {
      oneOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        {
          type: "object",
          additionalProperties: { $ref: "#/$defs/tokenOrGroup" },
          properties: {
            $value: {},
            $type: { type: "string" },
            $description: { type: "string" },
            $version: { type: "string" },
            deprecated: { type: "boolean" },
            replacedBy: { type: "string" },
          },
        },
      ],
    },
  },
};

export class TokenValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenValidationError";
  }
}

function assertTree(node, path, errors) {
  if (Array.isArray(node)) {
    errors.push(`arrays are not allowed at "${path.join(".")}"`);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$value" || key === "$type" || key === "$description" || key === "$version" || key === "deprecated" || key === "replacedBy") continue;
      assertTree(value, [...path, key], errors);
    }
    return;
  }
  if (
    typeof node !== "string" &&
    typeof node !== "number" &&
    typeof node !== "boolean"
  ) {
    errors.push(
      `invalid leaf "${path.join(".")}": expected string, number, or boolean`
    );
  }
}

export function validateTokens(tokens) {
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
    throw new TokenValidationError("tokens root must be a JSON object");
  }
  const errors = [];
  assertTree(tokens, [], errors);
  if (errors.length) {
    throw new TokenValidationError(errors.join("; "));
  }
  try {
    resolveReferences(tokens, {});
  } catch (err) {
    throw new TokenValidationError(err.message);
  }
  return true;
}
