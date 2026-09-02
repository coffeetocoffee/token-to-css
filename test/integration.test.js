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
    "  --spacing-lg: calc(1rem * 1.5);\n" +
    "}\n";
  assert.equal(css, expected);
});
