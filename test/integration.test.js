import { test } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../src/index.js";

test("convert produces stable CSS for a known token set (golden)", () => {
  const css = convert(
    {
      color: { primary: "#3b82f6" },
      spacing: { md: "1rem", lg: "{spacing.md} * 1.5" },
    },
    { format: "css" }
  );
  const expected =
    ":root {\n" +
    "  --color-primary: #3b82f6;\n" +
    "  --spacing-md: 1rem;\n" +
    "  --spacing-lg: 1.5rem;\n" +
    "}\n";
  assert.equal(css, expected);
});

test("convert emits source comments when requested", () => {
  const css = convert(
    { color: { primary: "#3b82f6" } },
    { format: "css", sourceComments: true }
  );
  assert.match(css, /\/\* color.primary \*\//);
  assert.match(css, /--color-primary: #3b82f6;/);
});
