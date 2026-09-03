/**
 * Public core surface for `token-to-css`.
 *
 * This module is the stable, plugin-free API that a future `@token-to-css/core`
 * npm package would expose. Plugins (e.g. `connectors/figma.js`) depend only on
 * this public surface via `registerPlugin` / `registerFunction` /
 * `registerFormat`, so the core has zero plugin dependencies and each plugin can
 * ship and install independently. Today everything lives in one package; this
 * entry point freezes the intended split boundary.
 */
export {
  convert,
  convertToMap,
  flattenTokens,
  normalizeW3C,
  applyMap,
  toCSS,
  toSCSS,
  toCSSModules,
  toBarefoot,
  resolveReferences,
  registerFunction,
  registerFormat,
  registerPlugin,
  validateTokens,
  TokenValidationError,
  lintTokens,
  checkContract,
  buildKit,
  buildKitCSS,
  buildThemeJS,
  buildBindings,
  buildPreviewHTML,
  splitThemes,
  THEME_JS,
  buildDocsSite,
  buildExplorerHTML,
  buildProvenance,
  reverse,
  reverseStyleDictionary,
  applyReversedIntoSource,
  computeDrift,
  canSetPath,
  buildNameRegistry,
  registryFromJSON,
  setByPath,
  getByPath,
  resolveTree,
  buildClientJS,
  createTokenServer,
  parseLocated,
} from "./index.js";
