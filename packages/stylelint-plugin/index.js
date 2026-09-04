// @token-to-css/stylelint — a Stylelint rule that flags hardcoded values which
// should instead reference a design token. Built purely on the public
// `token-to-css` surface (buildValueIndex + lintConsumer); it has zero plugin
// dependencies and registers through the published API only.
import { buildValueIndex, lintConsumer } from "token-to-css";

export const ruleName = "token-to-css/use-tokens";

/**
 * Create the rule bound to a token set. The `lintText` method is the engine;
 * `stylelintRule` adapts it to Stylelint's plugin rule signature. Either way the
 * rule has no runtime dependency on stylelint itself.
 */
export function createRule(tokens, options = {}) {
  return {
    ruleName,
    options,
    /** Core lint over a single file's text. Returns ConsumerFinding[]. */
    lintText(text, file = "<input>") {
      return lintConsumer(tokens, [{ file, text }], options).findings;
    },
    /** Stylelint-style rule factory. */
    stylelintRule() {
      return (primary, _secondary, context) => (root, result) => {
        root.walkDecls((decl) => {
          const findings = lintConsumer(
            tokens,
            [{ file: (decl.source && decl.source.input && decl.source.input.file) || "<input>", text: decl.value }],
            options
          ).findings;
          for (const f of findings) {
            context.report({
              ruleName,
              message: `Use ${f.variable} instead of hardcoded ${f.value}`,
              node: decl,
              line: f.line,
              column: f.column,
            });
          }
        });
      };
    },
  };
}
