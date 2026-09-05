/**
 * `token-to-css` — batteries-included meta-package (v11.5).
 *
 * This is the root package. The compiler surface now lives in
 * `@token-to-css/core` and the connector hub + connectors live in
 * `@token-to-css/connectors`; this entry point re-exports both so every
 * historical import path keeps working (the 1.0 SemVer contract). The
 * server/editor/MCP/relay/adoption layers remain in this package.
 */
export * from "@token-to-css/core";
export * from "@token-to-css/connectors";
export { createTokenServer, resolveTree } from "./serve.js";
export { validateEditValue, buildEditCommit, editImpact, previewEdit, buildEditorHTML } from "./editor.js";
export { createMcpContext, handleMcpMessage } from "./mcp.js";
export { relayChange, attachOrgRelay, consumeSSE, handleRelayPost } from "./relay.js";
export {
  buildValueIndex,
  lintConsumer,
  applyConsumerCodemod,
  computeAdoptionScore,
  storeSnapshot,
  loadSnapshots,
  computeOrgAdoption,
  computeFederatedAdoption,
  scanSource,
} from "./adopt.js";
