// @token-to-css/eslint — an ESLint rule that flags hardcoded values which should
// instead reference a design token. Built purely on the public `token-to-css`
// surface (lintConsumer); it has zero plugin dependencies and registers through
// the published API only.
import { buildValueIndex, lintConsumer } from "token-to-css";

export const ruleName = "token-to-css/use-tokens";

/**
 * Create the rule bound to a token set. `lintText` is the engine; `eslintRule`
 * adapts it to ESLint's rule object shape. The package never imports eslint.
 */
export function createRule(tokens, options = {}) {
  return {
    ruleName,
    options,
    /** Core lint over a single file's text. Returns ConsumerFinding[]. */
    lintText(text, file = "<input>") {
      return lintConsumer(tokens, [{ file, text }], options).findings;
    },
    /** ESLint-style rule object. */
    eslintRule() {
      return {
        meta: {
          type: "suggestion",
          docs: { description: "Use design tokens instead of hardcoded values" },
          messages: { useToken: "Use {{name}} instead of hardcoded {{value}}" },
        },
        create(context) {
          const reportText = (node, text, file) => {
            const findings = lintConsumer(
              tokens,
              [{ file: file || context.getFilename(), text }],
              options
            ).findings;
            for (const f of findings) {
              context.report({
                node,
                messageId: "useToken",
                data: { name: f.variable, value: f.value },
              });
            }
          };
          return {
            Literal(node) {
              if (typeof node.value === "string") reportText(node, node.value);
            },
          };
        },
      };
    },
  };
}
