#!/usr/bin/env node
import { readFileSync, writeFileSync, watch, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, join as joinPath, dirname } from "node:path";
import {
  convert,
  convertToMap,
  diffTokens,
  lintTokens,
  checkContract,
  buildKit,
  reverse,
  resolveReferences,
  createTokenServer,
  buildNameRegistry,
  registryFromJSON,
  lintConsumer,
  applyConsumerCodemod,
  computeAdoptionScore,
  storeSnapshot,
  loadSnapshots,
  createMcpContext,
  handleMcpMessage,
  release as computeRelease,
  bisectToken,
  renderSideBySide,
  analyzeLockfile,
  classifyRelease,
} from "./index.js";
import { applyReversedIntoSource, computeDrift } from "./sync.js";
import { deepMerge } from "./merge.js";
import { expandGlob, globBaseDir } from "./glob.js";
import { parseLocated } from "./locate.js";
import { buildExplorerHTML } from "./docs.js";
import { addVersionMarkers, getDeprecations, createChangeRequest, approveChangeRequest, rejectChangeRequest } from "./governance.js";
import { getImpactGraph, generateCodemod, applyCodemod, generateCSSCodemod } from "./migrate.js";
import {
  buildOrgManifest,
  resolveOrgTree,
  lintOrg,
  mergeRegistries as mergeOrgRegistries,
  buildFederatedManifest,
  validateFederatedManifest,
  resolveFederatedTree,
  analyzeCrossOrgLock,
} from "./federation.js";
import { computeFederatedAdoption } from "./adopt.js";
import { attachOrgRelay } from "./relay.js";
import { registerStorybookConnector } from "./connectors/storybook.js";
import { registerGithubPrConnector } from "./connectors/github.js";
import { registerCmsConnector } from "./connectors/cms.js";

// Eagerly register the built-in connectors' output formats so `-f storybook`,
// `-f github`, and `-f cms` work out of the box. The connectors register a
// format; their push/pull remain no-op until configured with a transport.
registerStorybookConnector({});
registerGithubPrConnector({});
registerCmsConnector({});

const REPEATABLE = new Set(["import", "i", "glob", "g", "output", "o", "mode", "relay"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      args._.push(a);
      continue;
    }
    const key = a.replace(/^-+/, "");
    const eq = key.indexOf("=");
    if (eq !== -1) {
      args[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      if (REPEATABLE.has(key)) {
        const cur = args[key];
        args[key] = cur ? [...(Array.isArray(cur) ? cur : [cur]), next] : [next];
      } else {
        args[key] = next;
      }
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`token-to-css - convert design tokens to CSS

Usage:
  token-to-css <input.json> [options]
  token-to-css kit <input.json> [--out-dir dist] [options]
  token-to-css lint <input.json> [--contract schema.json] [--json]
  token-to-css reverse <file.css> [-o tokens.json] [--registry names.json]
  token-to-css snapshot <input.json> [-o snap.json]
  token-to-css history <snap-a.json> <snap-b.json> [snap-c.json ...]
  token-to-css sync <input.json> [options]
  token-to-css serve <input.json> [--port 4173] [--playground] [--editor] [--registry] [--relay <peer-url>]
  token-to-css migrate <input.json> --from <path> --to <path> [--codemod <dir>] [--dry-run]
  token-to-css migrate <input.json> --deprecated [--codemod <dir>]
  token-to-css federate <org.manifest.json> [-o <output>] [--lint] [--team <name>] [--adopt <dir>]
  token-to-css federate <fed.manifest.json> [--org <name>] [--adopt <dir>]   (cross-org, v11)
  token-to-css govern <input.json> [--version <semver>] [--deprecate <path> --replaced-by <path>]
  token-to-css adopt <tokens.json> <sources...> [--fix] [--report] [--registry] [--snapshots <file>] [--max-distance 0.1]
  token-to-css mcp <tokens.json> [--serve-url <url>]
  token-to-css release <prev.json> <next.json> [--version x.y.z] [--changelog <file>]
  token-to-css lock <lockfile.json> <prev.json> <next.json> [--version x.y.z]
  token-to-css bisect <token.path> --checkpoints <dir>

Options:
  -o, --output <[fmt:]file>  Write output (repeatable); prefix format, e.g. scss:out.scss
  -f, --format <name>   css | scss | barefoot | css-modules | json | tailwind | style-dictionary | schema | report | docs | ts | js | figma  (default: css)
  -s, --selector <sel>  CSS selector for variables (default: :root)
  -t, --theme <name>    barefoot only: wrap in [data-bf-theme="name"]
  -m, --map <file>      barefoot only: JSON file mapping token names to vars
  -i, --import <file>   Merge additional token files (repeatable)
  -g, --glob <pattern>  Merge files matching a glob (repeatable)
  -c, --config <file>   Config file with default options (default: auto-detect)
  -w, --watch           Re-generate whenever an input file changes
  -B, --brand <name>    Apply a named brand override from a \`brands\`/\`brand\` key
  -R, --no-resolve      Do not resolve {token} references
  -z, --no-reduce       Keep arithmetic as calc() instead of collapsing it
  -C, --source-comments Emit a /* token.path */ comment above each variable
  -M, --source-map      Write a <file>.map source map alongside each output file
  --registry            Emit/consume a canonical name registry (tokens.names.json) so
                       round-trips are lossless for kebab-colliding token names
  --auth <file>         Enable token-gated access: JSON map of token -> "read"|"write"
  --strict              Fail on arithmetic with mismatched units (no calc() fallback)
  --diff <a> <b>       Print a token diff report for two token files, then exit
  --check               Dry-run: fail (exit 1) when an -o output is stale vs tokens
  --contract <file>     Enforce required tokens + types via a JSON Schema file
  --out-dir <dir>       Output directory for the kit subcommand (default: dist)
  --json                With lint: print issues as JSON
  --serve              Serve generated outputs on a local HTTP server (with -w)
  --playground         With serve: host the live kit preview + "propose change"
  --editor             With serve: serve the visual token editor at /editor (default on)
  --port <n>           Port for --serve (default: 4173)
   --approve            With serve: require approval for POST /tokens (change-request mode)
   --org <name>         With serve: this server's org id (org-scoped auth tokens)
  --from <path>        With migrate: source token path to rename
  --to <path>          With migrate: target token path for rename
  --codemod <dir>      With migrate: write codemod JSON to directory
  --dry-run            With migrate: show changes without writing
  --deprecated         With migrate: generate codemods for all deprecated tokens
  --team <name>        With federate: filter to a specific team
  --lint               With federate: run lint across all teams
  --org <name>         With federate (cross-org): emit/rollup a single org, or all when omitted
  --lock <file>        With federate: check cross-org consumer lockfiles against published packages
  --version <semver>   With govern: set version on all tokens
  --deprecate <path>   With govern: mark a token as deprecated
  --replaced-by <path> With govern: replacement for deprecated token
  --fix                With adopt: rewrite matched literals to var(--token) (idempotent)
  --report             With adopt: print the adoption score (use --snapshots to persist trend)
  --snapshots <file>   With adopt --report: append a snapshot + print the trend
  --max-distance <n>   With adopt: OKLCH nearest-match threshold (default 0.1)
  --src <file>         With adopt: extra consumer source file/glob (repeatable)
  --serve-url <url>    With mcp: point change-request creation at a running serve instance
   --canary <file>      With serve: enable a canary release channel from a token file
   --relay <url>        With serve: subscribe to a peer org's serve instance; remote
                       changes arrive as change-requests (v11 cross-org relay)
  --changelog <file>   With release: prepend the generated changelog section to a file
  --checkpoints <dir>  With bisect: directory of ordered snapshot .json checkpoints
  -n, --no-validate     Skip token validation
  -h, --help            Show help

Subcommands:
  kit                 Emit a theme package (theme.css + theme.js + tokens.ts/js + index.html)
  lint                Check token health (unused/duplicate/untyped/broken $type/brands)
  reverse <file>      Parse CSS/SCSS back into a token tree (best-effort round-trip)
  snapshot <input>    Write the fully resolved token tree (for cross-version diffing)
  history <a> <b>...  Diff a sequence of snapshots across versions
  sync <input>        Watch tokens + artifacts; external edits reverse-sync back
  serve <input>       Run the live Token Server (REST + SSE mesh) for an org
  migrate <input>     Generate migration codemods for token renames/deprecations
  federate <manifest> Compose multi-team token trees via an org manifest
  govern <input>      Manage token versioning and deprecation markers
  adopt <tokens> <src> Scan consumer source for hardcoded token values; --fix rewrites them
  mcp <tokens>        Run the Model Context Protocol server (JSON-RPC over stdio)
  release <a> <b>     Classify a token diff into a semver bump + changelog
  lock <lock> <a> <b> Check a consumer lockfile against a release for breaking changes
  bisect <token>      Walk checkpoints to find the change that flipped a token value
`);
}

function readTokensFile(p) {
  return JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8"));
}

function readLocated(p) {
  const text = readFileSync(resolve(process.cwd(), p), "utf8");
  return { ...parseLocated(text, p), text };
}

function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function loadLocated(paths) {
  const merged = {};
  const loc = {};
  const sourcesContent = {};
  for (const p of paths) {
    const { tree, loc: l, text } = readLocated(p);
    deepMerge(merged, tree);
    Object.assign(loc, l);
    sourcesContent[p] = text;
  }
  return { merged, loc, sourcesContent };
}

function findConfig(explicit) {
  if (explicit) {
    const p = resolve(process.cwd(), explicit);
    if (existsSync(p)) return p;
    throw new Error(`config file not found: ${p}`);
  }
  for (const name of ["token-to-css.config.json", ".token-to-cssrc"]) {
    const p = resolve(process.cwd(), name);
    if (existsSync(p)) return p;
  }
  return null;
}

const CONFIG_V2_KEYS = new Set([
  "version",
  "format",
  "selector",
  "theme",
  "map",
  "preset",
  "presets",
  "brand",
  "port",
  "modes",
  "inputs",
  "imports",
  "glob",
  "output",
  "outputs",
  "check",
  "contract",
  "outDir",
  "out-dir",
]);

function validateConfigV2(raw) {
  for (const key of Object.keys(raw)) {
    if (!CONFIG_V2_KEYS.has(key))
      throw new Error(`unknown config key in v2 schema: "${key}"`);
  }
  if (raw.output && raw.outputs)
    throw new Error('config v2: use "output" or "outputs", not both');
  if (raw.outputs != null && !Array.isArray(raw.outputs))
    throw new Error('config v2: "outputs" must be an array');
  if (raw.outputs) {
    for (const o of raw.outputs) {
      if (typeof o === "string") continue;
      if (!o || typeof o.file !== "string")
        throw new Error('config v2: each output needs a "file"');
      if (o.format != null && typeof o.format !== "string")
        throw new Error("config v2: output.format must be a string");
    }
  }
  if (raw.inputs != null && !Array.isArray(raw.inputs))
    throw new Error('config v2: "inputs" must be an array');
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") return {};
  const version = raw.version ?? 1;
  if (version === 1) return raw;
  if (version !== 2)
    throw new Error(`unsupported config version: ${version}`);
  validateConfigV2(raw);
  const cfg = {};
  if (raw.format) cfg.format = raw.format;
  if (raw.selector) cfg.selector = raw.selector;
  if (raw.theme) cfg.theme = raw.theme;
  if (raw.map) cfg.map = raw.map;
  if (raw.preset) cfg.preset = raw.preset;
  if (raw.presets) cfg.preset = Array.isArray(raw.presets) ? raw.presets[0] : raw.presets;
  if (raw.brand) cfg.brand = raw.brand;
  if (raw.port) cfg.port = raw.port;
  if (raw.modes) cfg.modes = raw.modes;
  if (raw.imports) cfg.imports = raw.imports;
  if (raw.inputs) cfg.imports = raw.inputs;
  if (raw.glob) cfg.glob = raw.glob;
  if (raw.output && !raw.outputs) cfg.output = raw.output;
  if (raw.outputs)
    cfg.output = raw.outputs.map((o) =>
      typeof o === "string" ? o : `${o.format || "css"}:${o.file}`
    );
  if (raw.contract) cfg.contract = raw.contract;
  if (raw.check != null) cfg.check = raw.check;
  if (raw.outDir) cfg.outDir = raw.outDir;
  if (raw["out-dir"]) cfg.outDir = raw["out-dir"];
  return cfg;
}

function loadConfig(configPath) {
  if (!configPath) return {};
  return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
}

function readPackageConfig() {
  const p = resolve(process.cwd(), "package.json");
  if (!existsSync(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    if (pkg && pkg.tokenToCss) return normalizeConfig(pkg.tokenToCss);
  } catch {
    return null;
  }
  return null;
}

export const KNOWN_FORMATS = [
  "css",
  "scss",
  "barefoot",
  "css-modules",
  "json",
  "tailwind",
  "style-dictionary",
  "schema",
  "report",
  "docs",
  "provenance",
  "ts",
  "js",
  "figma",
  "storybook",
  "github",
  "cms",
];

function parseOutputs(list, defaultFormat) {
  return list.map((spec) => {
    const m = /^([a-z-]+):(.+)$/i.exec(spec);
    if (m && KNOWN_FORMATS.includes(m[1].toLowerCase())) {
      return { format: m[1].toLowerCase(), path: m[2] };
    }
    return { format: null, path: spec };
  });
}

function enforceContract(merged, contractPath) {
  if (!contractPath) return;
  const schema = JSON.parse(
    readFileSync(resolve(process.cwd(), contractPath), "utf8")
  );
  checkContract(merged, schema);
}

/**
 * Write only when content differs from what's on disk, so re-generation is a
 * no-op write. This keeps `sync` watch loops from re-triggering on their own
 * output (a regenerated file that matches the external edit writes nothing).
 */
function safeWrite(path, content) {
  const rp = resolve(process.cwd(), path);
  try {
    if (readFileSync(rp, "utf8") === content) return false;
  } catch {
    /* file missing; write below */
  }
  writeFileSync(rp, content, "utf8");
  return true;
}

function generateAll(paths, options, outputs) {
  try {
    if (options.mapPath) {
      options.map = JSON.parse(readFileSync(options.mapPath, "utf8"));
    }
    const { merged, loc, sourcesContent } = loadLocated(paths);
    if (options.stdinText) {
      const l = parseLocated(options.stdinText, "<stdin>");
      deepMerge(merged, l.tree);
      Object.assign(loc, l.loc);
      sourcesContent["<stdin>"] = options.stdinText;
    }
    if (options.contract) enforceContract(merged, options.contract);
    for (const out of outputs) {
      const format = out.format || options.format;
      if (options.sourceMap && out.path) {
        const { css, map } = convertToMap(merged, loc, {
          ...options,
          format,
          outputFile: out.path,
          sourcesContent,
        });
        const mapPath = `${out.path}.map`;
        safeWrite(mapPath, JSON.stringify(map, null, 2));
        const base = out.path.split(/[\\/]/).pop();
        safeWrite(
          out.path,
          `${css}/*# sourceMappingURL=${base}.map */\n`
        );
        console.error(`wrote ${format} to ${resolve(process.cwd(), out.path)}`);
      } else {
        const css = convert(merged, { ...options, format });
        if (out.path) {
          const outPath = resolve(process.cwd(), out.path);
          safeWrite(outPath, css);
          console.error(`wrote ${format} to ${outPath}`);
        } else {
          process.stdout.write(css);
        }
      }
    }
    if (options.registry) {
      const reg = buildNameRegistry(merged);
      const namesPath = outputs.length && outputs[0].path
        ? resolve(process.cwd(), `${outputs[0].path}.names.json`)
        : null;
      if (namesPath) {
        safeWrite(namesPath, `${JSON.stringify(reg.toJSON(), null, 2)}\n`);
        console.error(`wrote registry to ${namesPath}`);
      }
    }
    return true;
  } catch (err) {
    console.error(`error: ${err.message}`);
    return false;
  }
}

/**
 * --check: dry-run that fails when a file output is stale vs tokens.
 * Reuses convert/convertToMap for the expected bytes and diffTokens to
 * explain JSON staleness.
 */
function checkAll(paths, options, outputs) {
  try {
    if (options.mapPath) {
      options.map = JSON.parse(readFileSync(options.mapPath, "utf8"));
    }
    const { merged, loc, sourcesContent } = loadLocated(paths);
    if (options.stdinText) {
      const l = parseLocated(options.stdinText, "<stdin>");
      deepMerge(merged, l.tree);
      Object.assign(loc, l.loc);
      sourcesContent["<stdin>"] = options.stdinText;
    }
    if (options.contract) enforceContract(merged, options.contract);
    const fileOutputs = outputs.filter((o) => o.path);
    if (!fileOutputs.length) {
      console.error("error: --check requires at least one -o <file> output");
      return false;
    }
    let stale = false;
    for (const out of fileOutputs) {
      const format = out.format || options.format;
      let expected;
      if (options.sourceMap) {
        const { css, map } = convertToMap(merged, loc, {
          ...options,
          format,
          outputFile: out.path,
          sourcesContent,
        });
        void map;
        const base = out.path.split(/[\\/]/).pop();
        expected = `${css}/*# sourceMappingURL=${base}.map */\n`;
      } else {
        expected = convert(merged, { ...options, format });
      }
      const outPath = resolve(process.cwd(), out.path);
      let actual = null;
      try {
        actual = readFileSync(outPath, "utf8");
      } catch {
        actual = null;
      }
      if (actual !== expected) {
        stale = true;
        if (actual == null) {
          console.error(`stale: ${out.path} (missing, run without --check to generate)`);
        } else {
          console.error(`stale: ${out.path} differs from tokens; run without --check to regenerate`);
          if (format === "json") {
            try {
              const d = diffTokens(JSON.parse(actual), JSON.parse(expected));
              const n =
                Object.keys(d.added).length +
                Object.keys(d.removed).length +
                Object.keys(d.changed).length;
              if (n > 0) {
                console.error(
                  `  diff: +${Object.keys(d.added).length} -${Object.keys(d.removed).length} ~${Object.keys(d.changed).length}`
                );
              }
            } catch {
              /* actual is not JSON (e.g. stale CSS in a .json path); skip */
            }
          }
        }
      }
    }
    if (!stale) console.error("check: all outputs are up to date");
    return !stale;
  } catch (err) {
    console.error(`error: ${err.message}`);
    return false;
  }
}

function watchFile(source, onChange) {
  let timer;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 50);
  };
  const attach = (w) => {
    if (w && typeof w.on === "function") w.on("error", () => {});
  };
  try {
    attach(watch(source, { persistent: true }, fire));
  } catch {
    // source may not exist yet (e.g. generated on first run); watch its parent
    // directory and react only to this file's creation/edits.
    const base = dirname(source);
    try {
      attach(
        watch(base, { persistent: true }, (_ev, fn) => {
          if (fn && resolve(base, fn) === resolve(source)) fire();
        })
      );
    } catch {
      /* directory watching unsupported here */
    }
  }
}

function startServer(outputs, port, explorerHtml) {
  const files = outputs
    .filter((o) => o.path)
    .map((o) => ({
      path: resolve(process.cwd(), o.path),
      name: o.path.split(/[\\/]/).pop(),
      format: o.format || "css",
    }));
  const ct = (f) =>
    f && (f.format === "json" || f.format === "schema" || f.format === "style-dictionary")
      ? "application/json"
      : f && (f.format === "report" || f.format === "docs")
        ? "text/html; charset=utf-8"
        : "text/css";
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if ((url === "/" || url === "") && explorerHtml) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(explorerHtml);
      return;
    }
    if ((url === "/" || url === "") && !explorerHtml) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const items = files.length
        ? files.map((f) => `<li><a href="/${encodeURIComponent(f.name)}">${f.name}</a></li>`).join("")
        : "<li>(no file outputs; use -o path)</li>";
      res.end(`<h1>token-to-css</h1><ul>${items}</ul>`);
      return;
    }
    if ((url === "/explorer" || url === "/tokens") && explorerHtml) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(explorerHtml);
      return;
    }
    const name = decodeURIComponent(url.slice(1));
    const f = files.find((x) => x.name === name);
    if (!f) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const data = readFileSync(f.path, "utf8");
    res.writeHead(200, { "content-type": `${ct(f)}; charset=utf-8` });
    res.end(data);
  });
  server.listen(port, () => console.error(`serving on http://localhost:${port}`));
}

function collect(list) {
  if (!list) return [];
  return Array.isArray(list) ? list : [list];
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.diff) {
    const a = args.diff;
    const b = args._[0];
    if (!b) {
      console.error("error: --diff requires two files: --diff a.json b.json");
      return 1;
    }
    try {
      const ta = JSON.parse(readFileSync(resolve(process.cwd(), a), "utf8"));
      const tb = JSON.parse(readFileSync(resolve(process.cwd(), b), "utf8"));
      const d = diffTokens(ta, tb);
      const fmt = ([k, v]) => `  ${k}: ${v}`;
      let out = "";
      out += `Added (${Object.keys(d.added).length}):\n`;
      out += Object.entries(d.added).map(fmt).join("\n") + "\n";
      out += `Removed (${Object.keys(d.removed).length}):\n`;
      out += Object.entries(d.removed).map(fmt).join("\n") + "\n";
      out += `Changed (${Object.keys(d.changed).length}):\n`;
      out +=
        Object.entries(d.changed)
          .map(([k, v]) => `  ${k}: ${v.from} -> ${v.to}`)
          .join("\n") + "\n";
      process.stdout.write(out);
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      return 1;
    }
  }

  const configPath = findConfig(args.config || args.c);
  let config = loadConfig(configPath);
  if (!configPath) {
    const pkgConfig = readPackageConfig();
    if (pkgConfig) config = pkgConfig;
  }
  if (configPath) console.error(`using config ${configPath}`);

  const imports = [
    ...collect(config.imports),
    ...collect(args.import || args.i),
  ];
  const globs = [...collect(config.glob), ...collect(args.glob || args.g)];

  const sub =
    args._[0] === "kit" ||
    args._[0] === "lint" ||
    args._[0] === "reverse" ||
    args._[0] === "snapshot" ||
    args._[0] === "history" ||
    args._[0] === "sync" ||
    args._[0] === "serve" ||
    args._[0] === "migrate" ||
    args._[0] === "federate" ||
    args._[0] === "govern" ||
    args._[0] === "adopt" ||
    args._[0] === "mcp" ||
    args._[0] === "release" ||
    args._[0] === "bisect" ||
    args._[0] === "lock"
      ? args._[0]
      : null;
  const input = sub ? args._[1] : args._[0];
  if (!input && imports.length === 0 && globs.length === 0 && !args.stdin) {
    console.error(
      sub === "kit"
        ? "error: kit requires an input file: token-to-css kit <input.json>"
        : sub === "lint"
          ? "error: lint requires an input file: token-to-css lint <input.json>"
          : "error: no input file provided. Use --help for usage."
    );
    return 1;
  }

  const options = { format: args.format || args.f || config.format || "css" };
  if (args.selector || args.s) options.selector = args.selector || args.s;
  else if (config.selector) options.selector = config.selector;
  if (args.theme || args.t) options.theme = args.theme || args.t;
  else if (config.theme) options.theme = config.theme;
  if (args.map || args.m) options.mapPath = resolve(process.cwd(), args.map || args.m);
  else if (config.map) options.mapPath = resolve(process.cwd(), config.map);
  if (args["no-resolve"] === undefined && args.R === undefined) {
    options.resolve = true;
  } else {
    options.resolve = false;
  }
  options.reduce = !(args["no-reduce"] || args.z);
  options.sourceComments = Boolean(args["source-comments"] || args.C);
  options.sourceMap = Boolean(args["source-map"] || args.M);
  options.validate = !(args["no-validate"] || args.n);
  options.preset = args.preset || args.P || config.preset;
  options.modes = collect(args.mode || config.modes);
  options.brand = args.brand || args.B || config.brand;
  options.strict = Boolean(args.strict);
  options.serve = Boolean(args.serve);
  options.registry = Boolean(args.registry);
  options.playground = Boolean(args.playground);
  options.editor = args.editor !== "false";
  options.auth = null;
  if (args.auth || config.auth) {
    const authPath = resolve(process.cwd(), args.auth || config.auth);
    const authJson = JSON.parse(readFileSync(authPath, "utf8"));
    let map = {};
    if (Array.isArray(authJson)) map = Object.fromEntries(authJson.map((t) => [t.token, t.scope]));
    else if (authJson.tokens) map = Object.fromEntries(authJson.tokens.map((t) => [t.token, t.scope]));
    else map = authJson;
    options.auth = (token) => map[token] || null;
  }
  options.port = args.port || args.p || config.port || 4173;
  options.stdin = Boolean(args.stdin);
  if (options.stdin) options.stdinText = readStdinSync();
  options.initial = args.initial !== "false";
  options.check = Boolean(args.check || config.check);
  options.contract = args.contract || config.contract || null;
  options.outDir = args["out-dir"] || args.outDir || config.outDir || "dist";

  const rebuildPaths = () => [
    ...([input, ...imports].filter(Boolean)),
    ...globs.flatMap((g) => expandGlob(g)),
  ];

  if (sub === "lint") {
    try {
      if (options.mapPath) {
        options.map = JSON.parse(readFileSync(options.mapPath, "utf8"));
      }
      const { merged } = loadLocated(rebuildPaths());
      if (options.stdinText) {
        const l = parseLocated(options.stdinText, "<stdin>");
        deepMerge(merged, l.tree);
      }
      const { issues, errors, warnings } = lintTokens(merged);
      let contractError = null;
      if (options.contract) {
        try {
          enforceContract(merged, options.contract);
        } catch (err) {
          contractError = err;
        }
      }
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ issues, errors, warnings, contractError: contractError?.message || null }, null, 2)}\n`
        );
      } else {
        for (const i of issues) {
          process.stdout.write(`${i.severity}: [${i.rule}] ${i.message}\n`);
        }
        if (contractError) process.stdout.write(`error: [contract] ${contractError.message}\n`);
        if (!issues.length && !contractError) process.stdout.write("lint: no issues\n");
        else process.stdout.write(`lint: ${errors} error(s), ${warnings} warning(s)\n`);
      }
      const failed = errors > 0 || contractError;
      process.exitCode = failed ? 1 : 0;
      return failed ? 1 : 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "kit") {
    try {
      if (options.mapPath) {
        options.map = JSON.parse(readFileSync(options.mapPath, "utf8"));
      }
      const { merged } = loadLocated(rebuildPaths());
      if (options.stdinText) {
        const l = parseLocated(options.stdinText, "<stdin>");
        deepMerge(merged, l.tree);
      }
      if (options.contract) enforceContract(merged, options.contract);
      const kit = buildKit(merged, options);
      const outDir = resolve(process.cwd(), options.outDir);
      mkdirSync(outDir, { recursive: true });
      const files = {
        "theme.css": kit.css,
        "theme.js": kit.js,
        "tokens.ts": kit.ts,
        "tokens.js": kit.jsBindings,
        "index.html": kit.html,
      };
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(joinPath(outDir, name), content, "utf8");
        console.error(`wrote ${joinPath(outDir, name)}`);
      }
      if (options.registry) {
        const reg = buildNameRegistry(merged);
        writeFileSync(
          joinPath(outDir, "tokens.names.json"),
          `${JSON.stringify(reg.toJSON(), null, 2)}\n`,
          "utf8"
        );
        console.error(`wrote ${joinPath(outDir, "tokens.names.json")}`);
      }
      console.error(
        `kit: ${kit.modes.length} mode(s), ${kit.brands.length} brand(s), ${kit.names.length} token(s)`
      );
      process.exitCode = 0;
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "reverse") {
    try {
      const file = input;
      if (!file) {
        console.error("error: reverse requires a CSS/SCSS file: token-to-css reverse <file.css>");
        process.exitCode = 1;
        return 1;
      }
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      let reverseOptions = options;
      if (args.registry) {
        const regJson = JSON.parse(
          readFileSync(resolve(process.cwd(), args.registry), "utf8")
        );
        reverseOptions = { ...options, registry: registryFromJSON(regJson) };
      }
      const tree = reverse(text, reverseOptions);
      const out = JSON.stringify(tree, null, 2);
      const o = parseOutputs(collect(args.output || args.o), "json")[0];
      if (o && o.path) {
        writeFileSync(resolve(process.cwd(), o.path), out, "utf8");
        console.error(`wrote ${o.path}`);
      } else {
        process.stdout.write(out + "\n");
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "snapshot") {
    try {
      const { merged } = loadLocated(rebuildPaths());
      const resolved = options.resolve === false ? merged : resolveReferences(merged, { reduce: options.reduce });
      const out = JSON.stringify(resolved, null, 2);
      const o = parseOutputs(collect(args.output || args.o), "json")[0];
      if (o && o.path) {
        writeFileSync(resolve(process.cwd(), o.path), out, "utf8");
        console.error(`wrote ${o.path}`);
      } else {
        process.stdout.write(out + "\n");
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "history") {
    try {
      const files = args._.slice(1);
      if (files.length < 2) {
        console.error("error: history requires at least two snapshots: token-to-css history a.json b.json");
        process.exitCode = 1;
        return 1;
      }
      const read = (f) => JSON.parse(readFileSync(resolve(process.cwd(), f), "utf8"));
      let prevName = files[0];
      let prev = read(prevName);
      for (let i = 1; i < files.length; i++) {
        const curName = files[i];
        const cur = read(curName);
        const d = diffTokens(prev, cur);
        const a = Object.keys(d.added).length;
        const r = Object.keys(d.removed).length;
        const c = Object.keys(d.changed).length;
        console.log(`## ${prevName} -> ${curName}: +${a} -${r} ~${c}`);
        for (const [k, v] of Object.entries(d.added)) console.log(`  + ${k}: ${v}`);
        for (const [k, v] of Object.entries(d.removed)) console.log(`  - ${k}: ${v}`);
        for (const [k, v] of Object.entries(d.changed)) console.log(`  ~ ${k}: ${v.from} -> ${v.to}`);
        prevName = curName;
        prev = cur;
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "sync") {
    try {
      console.error(
        "sync is experimental: its behavior and library API may change in a minor release without a major bump."
      );
      if (!input && imports.length === 0 && globs.length === 0 && !args.stdin) {
        console.error("error: sync requires an input file: token-to-css sync <input.json> [options]");
        process.exitCode = 1;
        return 1;
      }
      const sourceFile =
        !args.stdin && !imports.length && !globs.length && input
          ? resolve(process.cwd(), input)
          : null;
      if (!sourceFile) {
        console.error(
          "sync: --import/--glob/--stdin inputs have no single source file to write back to; running forward-only watch"
        );
      }

      // Build the outputs to watch. Default to a sibling .css when nothing given.
      const userOutputs = parseOutputs(
        [...collect(config.output), ...collect(args.output || args.o)],
        options.format
      );
      const outputs =
        userOutputs.length > 0
          ? userOutputs
          : [{ format: null, path: sourceFile ? `${sourceFile.replace(/\.json$/i, "")}.sync.css` : null }];

      const writtenAt = new Map();
      const markWritten = (p) => writtenAt.set(resolve(process.cwd(), p), Date.now());

      const paths = [
        ...(input ? [input] : []),
        ...imports,
        ...globs.flatMap((g) => expandGlob(g)),
      ];
      const rebuild = () => [
        ...(input ? [input] : []),
        ...imports,
        ...globs.flatMap((g) => expandGlob(g)),
      ];

      const generate = () => {
        const okGen = generateAll(rebuild(), options, outputs);
        for (const o of outputs) if (o.path) markWritten(o.path);
        if (sourceFile) markWritten(sourceFile);
        return okGen;
      };

      const watched = new Set();
      const watchPath = (p, onChange) => {
        const rp = resolve(process.cwd(), p);
        if (watched.has(rp)) return;
        watched.add(rp);
        watchFile(rp, () => onChange());
      };

      const onOutputChange = (p) => {
        try {
          const text = readFileSync(resolve(process.cwd(), p), "utf8");
          const reversed = reverse(text, options);
          if (!sourceFile) {
            console.error(`sync: ${p} changed but no single source file; regenerating only`);
            generate();
            return;
          }
          const source = JSON.parse(readFileSync(sourceFile, "utf8"));
          const { source: updated, changed, skipped } = applyReversedIntoSource(source, reversed);
          if (changed.length === 0 && skipped.length === 0) return;
          writeFileSync(sourceFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
          console.error(
            `sync: ${p} -> ${sourceFile}: ~${changed.length}` +
              (skipped.length ? ` (skipped ${skipped.length} colliding name(s))` : "")
          );
          generate();
        } catch (e) {
          console.error(`sync error on ${p}: ${e.message}`);
        }
      };

      // Forward: source change regenerates outputs.
      for (const f of paths) watchPath(f, () => {
        console.error(`sync: ${f} changed; regenerating`);
        generate();
      });
      // Reverse: output artifact edit folds back into the source.
      for (const o of outputs) if (o.path) watchPath(o.path, () => onOutputChange(o.path));
      // Watch glob base dirs for new files.
      for (const g of globs) {
        const base = globBaseDir(g);
        try {
          watch(base, { persistent: true, recursive: true }, () => generate());
        } catch {
          /* directory watching unsupported here */
        }
      }
      console.error(
        `sync: watching ${[...watched].length} path(s)` + (sourceFile ? `; source of truth: ${sourceFile}` : "")
      );
      // Watchers are live before the first generation so an external edit in the
      // gap between generation and watching can't be missed.
      let ok = true;
      if (!(args.initial === "false")) ok = generate();
      if (options.serve) {
        let explorerHtml = null;
        try {
          const { merged } = loadLocated(rebuild());
          explorerHtml = buildExplorerHTML(merged, {
            ...options,
            files: outputs.filter((o) => o.path).map((o) => ({ name: o.path.split(/[\\/]/).pop() })),
          });
        } catch {
          explorerHtml = null;
        }
        startServer(outputs, options.port, explorerHtml);
      }
      process.exitCode = ok ? 0 : 1;
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "serve") {
    try {
      if (!input && imports.length === 0 && globs.length === 0 && !args.stdin) {
        console.error(
          "error: serve requires an input file: token-to-css serve <input.json> [--playground]"
        );
        process.exitCode = 1;
        return 1;
      }
      const tokensPath = !args.stdin && input ? resolve(process.cwd(), input) : null;
      const server = createTokenServer({
        tokensPath,
        tokens: args.stdin ? JSON.parse(options.stdinText) : undefined,
        port: options.port,
        watch: true,
        playground: options.playground,
        editor: options.editor,
        registry: options.registry,
        auth: options.auth,
        approve: options.approve,
        channels: args.canary ? { canary: readTokensFile(args.canary) } : undefined,
        org: args.org || null,
        streamUrl: "/events",
      });
      // v11.0 cross-org relay: subscribe to peer org serve instances; remote
      // updates arrive as pending change-requests (never direct writes).
      if (args.relay) {
        const peers = collect(args.relay);
        const relay = attachOrgRelay({
          selfUrl: `http://localhost:${options.port}`,
          peerUrls: peers,
          token: args["relay-token"] || null,
          origin: args.org || null,
          getCurrentTree: server.getSourceTree,
        });
        console.error(`relay: linked to ${peers.join(", ")} (remote edits arrive as change-requests)`);
        const origCloseAll = server.closeAll.bind(server);
        server.closeAll = () => {
          relay.stop();
          origCloseAll();
        };
      }
      server.listen(options.port, () =>
        console.error(
          `token-to-css serve listening on http://localhost:${options.port}`
        )
      );
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "migrate") {
    try {
      if (!input) {
        console.error("error: migrate requires an input file: token-to-css migrate <input.json>");
        process.exitCode = 1;
        return 1;
      }
      const { merged } = loadLocated(rebuildPaths());
      const from = args.from;
      const to = args.to;
      const codemodDir = args.codemod;
      const dryRun = Boolean(args["dry-run"]);
      const deprecatedOnly = Boolean(args.deprecated);

      if (!from && !deprecatedOnly) {
        console.error("error: migrate requires --from or --deprecated");
        process.exitCode = 1;
        return 1;
      }

      if (deprecatedOnly) {
        const deprecations = getDeprecations(merged);
        if (deprecations.length === 0) {
          console.log("no deprecated tokens found");
          return 0;
        }
        console.log(`found ${deprecations.length} deprecated token(s):`);
        for (const d of deprecations) {
          console.log(`  ${d.path}${d.replacedBy ? ` -> ${d.replacedBy}` : ""}`);
        }
        if (codemodDir && !dryRun) {
          for (const d of deprecations) {
            if (d.replacedBy) {
              const codemod = generateCodemod(merged, { from: d.path, to: d.replacedBy });
              const outPath = joinPath(resolve(process.cwd(), codemodDir), `${d.path.replace(/\./g, "-")}.codemod.json`);
              mkdirSync(dirname(outPath), { recursive: true });
              writeFileSync(outPath, `${JSON.stringify(codemod, null, 2)}\n`, "utf8");
              console.log(`  wrote ${outPath}`);
            }
          }
        }
        return 0;
      }

      if (!to) {
        console.error("error: migrate --from requires --to");
        process.exitCode = 1;
        return 1;
      }

      const codemod = generateCodemod(merged, { from, to });
      console.log(`impact: ${codemod.impact.direct} direct, ${codemod.impact.transitive} transitive`);
      console.log(`operations: ${codemod.operations.length}`);

      if (dryRun) {
        console.log("\noperations:");
        for (const op of codemod.operations) {
          if (op.type === "rename") {
            console.log(`  rename ${op.from} -> ${op.to}`);
          } else if (op.type === "update-ref") {
            console.log(`  update ref in ${op.path}`);
          }
        }
        return 0;
      }

      if (codemodDir) {
        const outPath = joinPath(resolve(process.cwd(), codemodDir), `${from.replace(/\./g, "-")}-to-${to.replace(/\./g, "-")}.codemod.json`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, `${JSON.stringify(codemod, null, 2)}\n`, "utf8");
        console.log(`wrote ${outPath}`);
      } else {
        process.stdout.write(`${JSON.stringify(codemod, null, 2)}\n`);
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "federate") {
    try {
      if (!input) {
        console.error("error: federate requires a manifest: token-to-css federate <org.manifest.json>");
        process.exitCode = 1;
        return 1;
      }
      const manifestPath = resolve(process.cwd(), input);

      // v11.0 cross-org federation: a manifest with an `orgs` key composes
      // whole org manifests (local paths or published token packages).
      const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (rawManifest && rawManifest.orgs) {
        const fed = validateFederatedManifest(rawManifest, manifestPath);
        const { merged, orgTrees, origins } = resolveFederatedTree(fed);

        if (args.lock) {
          const lock = readTokensFile(args.lock);
          const pkgName = lock.package;
          const dir =
            (fed.orgs &&
              Object.values(fed.orgs).find((m) => m.packages && m.packages[pkgName])
                ?.packages[pkgName]) ||
            null;
          if (!dir) {
            console.error(`error: package "${pkgName}" is not declared in any org's "packages" map`);
            process.exitCode = 1;
            return 1;
          }
          const res = analyzeCrossOrgLock(lock, dir);
          console.log(
            `cross-org lockfile ${lock.name || "<unnamed>"} pinned ${lock.range || "*"} on ${pkgName}: ${res.prevVersion} -> ${res.nextVersion}`
          );
          console.log(`  in range: ${res.inRange}  ok: ${res.ok}`);
          for (const b of res.breaking) {
            console.log(`  ${b.type}: ${b.path}${b.type === "changed" ? ` (${b.from} -> ${b.to})` : ""}`);
          }
          process.exitCode = res.ok ? 0 : 1;
          return process.exitCode;
        }

        if (args.adopt) {
          const adoptDir = resolve(process.cwd(), args.adopt);
          const orgTeamTrees = {};
          const sourcesByOrg = {};
          for (const [org, orgManifest] of Object.entries(fed.orgs)) {
            orgTeamTrees[org] = orgTrees[org].teamTrees;
            sourcesByOrg[org] = {};
            for (const team of Object.keys(orgManifest.teams)) {
              const teamDir = joinPath(adoptDir, org, team);
              const files = [];
              try {
                for (const f of expandGlob(joinPath(teamDir, "**", "*.{css,scss,ts,js,tsx,jsx}"))) {
                  files.push({ file: f, text: readFileSync(resolve(process.cwd(), f), "utf8") });
                }
              } catch {
                /* team has no consumer sources */
              }
              sourcesByOrg[org][team] = files;
            }
          }
          const { orgs, combined } = computeFederatedAdoption(orgTeamTrees, sourcesByOrg);
          console.log("cross-org adoption rollup:");
          for (const [org, info] of Object.entries(orgs)) {
            console.log(`  ${org}: ${info.org.score}% (adopted ${info.org.adopted}, hardcoded ${info.org.hardcoded})`);
            for (const [team, tinfo] of Object.entries(info.teams)) {
              console.log(`    ${org}/${team}: ${tinfo.score}% (adopted ${tinfo.adopted}, hardcoded ${tinfo.hardcoded})`);
            }
          }
          console.log(`  combined: ${combined.score}% (adopted ${combined.adopted}, hardcoded ${combined.hardcoded})`);
          return 0;
        }

        const orgFilter = args.org;
        const outTree = orgFilter && orgTrees[orgFilter] ? orgTrees[orgFilter].merged : merged;
        const format = options.format || "css";
        const css = convert(outTree, { format, ...options });
        const outPath = args.output || args.o;
        if (outPath) {
          writeFileSync(resolve(process.cwd(), outPath), css, "utf8");
          console.error(`wrote ${outPath}`);
        } else {
          process.stdout.write(css);
        }
        if (args.verbose) {
          for (const [p, o] of Object.entries(origins)) {
            console.error(`  origin ${p}: ${o.org}/${o.team}`);
          }
        }
        return 0;
      }

      const manifest = buildOrgManifest(manifestPath);

      if (args.lint) {
        const results = lintOrg(manifest);
        let hasErrors = false;
        for (const [team, result] of Object.entries(results)) {
          if (result.error) {
            console.error(`  ${team}: ${result.error}`);
            hasErrors = true;
            continue;
          }
          if (result.lint && result.lint.errors > 0) {
            console.error(`  ${team}: ${result.lint.errors} error(s), ${result.lint.warnings} warning(s)`);
            hasErrors = true;
          } else {
            console.log(`  ${team}: ok`);
          }
        }
        process.exitCode = hasErrors ? 1 : 0;
        return hasErrors ? 1 : 0;
      }

      const teamFilter = args.team;
      const { merged, teamTrees } = resolveOrgTree(manifest);

      if (args.adopt) {
        const adoptDir = resolve(process.cwd(), args.adopt);
        const sourcesByTeam = {};
        for (const team of Object.keys(manifest.teams)) {
          const teamDir = joinPath(adoptDir, team);
          const files = [];
          try {
            for (const f of expandGlob(joinPath(teamDir, "**", "*.{css,scss,ts,js,tsx,jsx}"))) {
              files.push({ file: f, text: readFileSync(resolve(process.cwd(), f), "utf8") });
            }
          } catch {
            /* team has no consumer sources */
          }
          sourcesByTeam[team] = files;
        }
        const { teams, org } = computeOrgAdoption(manifest, resolveOrgTree, sourcesByTeam);
        console.log("adoption rollup:");
        for (const [team, info] of Object.entries(teams)) {
          console.log(`  ${team}: ${info.score}% (adopted ${info.adopted}, hardcoded ${info.hardcoded})`);
        }
        console.log(`  org: ${org.score}% (adopted ${org.adopted}, hardcoded ${org.hardcoded})`);
        return 0;
      }

      if (teamFilter && teamTrees[teamFilter]) {
        const teamTree = teamTrees[teamFilter];
        const format = options.format || "css";
        const css = convert(teamTree, { format, ...options });
        const outPath = args.output || args.o;
        if (outPath) {
          writeFileSync(resolve(process.cwd(), outPath), css, "utf8");
          console.error(`wrote ${outPath}`);
        } else {
          process.stdout.write(css);
        }
        return 0;
      }

      const format = options.format || "css";
      const css = convert(merged, { format, ...options });
      const outPath = args.output || args.o;
      if (outPath) {
        writeFileSync(resolve(process.cwd(), outPath), css, "utf8");
        console.error(`wrote ${outPath}`);
      } else {
        process.stdout.write(css);
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "govern") {
    try {
      if (!input) {
        console.error("error: govern requires an input file: token-to-css govern <input.json>");
        process.exitCode = 1;
        return 1;
      }
      const { merged } = loadLocated(rebuildPaths());
      let tree = structuredClone(merged);

      if (args.version) {
        tree = addVersionMarkers(tree, args.version);
        console.log(`added version "${args.version}" to all tokens`);
      }

      if (args.deprecate) {
        const deprecatePath = args.deprecate;
        const replacedBy = args["replaced-by"] || null;
        const parts = deprecatePath.split(".");
        let node = tree;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!node[parts[i]]) node[parts[i]] = {};
          node = node[parts[i]];
        }
        const leaf = parts[parts.length - 1];
        if (node[leaf] && typeof node[leaf] === "object") {
          if ("$value" in node[leaf]) {
            node[leaf].deprecated = true;
            if (replacedBy) node[leaf].replacedBy = replacedBy;
            console.log(`deprecated ${deprecatePath}${replacedBy ? ` -> ${replacedBy}` : ""}`);
          } else {
            console.error(`error: ${deprecatePath} is not a leaf token`);
            process.exitCode = 1;
            return 1;
          }
        } else {
          console.error(`error: token not found: ${deprecatePath}`);
          process.exitCode = 1;
          return 1;
        }
      }

      const outPath = args.output || args.o;
      if (outPath) {
        writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(tree, null, 2)}\n`, "utf8");
        console.error(`wrote ${outPath}`);
      } else {
        process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "adopt") {
    try {
      if (!input) {
        console.error(
          "error: adopt requires a token file and source files: token-to-css adopt <tokens.json> <sources...>"
        );
        process.exitCode = 1;
        return 1;
      }
      const { merged } = loadLocated(rebuildPaths());
      const sourceArgs = [...args._.slice(2), ...collect(args.src || args.s)];
      if (sourceArgs.length === 0) {
        console.error("error: adopt requires at least one source file/glob");
        process.exitCode = 1;
        return 1;
      }
      const sources = [];
      for (const s of sourceArgs) {
        for (const f of expandGlob(s)) {
          sources.push({ file: f, text: readFileSync(resolve(process.cwd(), f), "utf8") });
        }
      }
      const registry = args.registry ? buildNameRegistry(merged) : null;
      const adoptOptions = {
        registry,
        maxDistance: args["max-distance"] != null ? Number(args["max-distance"]) : 0.1,
      };

      if (args.report) {
        const score = computeAdoptionScore(merged, sources, adoptOptions);
        let out = `adoption score: ${score.score}% (adopted ${score.adopted}, hardcoded ${score.hardcoded})\n`;
        if (args.snapshots) {
          const all = storeSnapshot(resolve(process.cwd(), args.snapshots), score);
          out += `snapshots stored: ${all.length}\n`;
          out += all.map((s) => `  ${s.date}: ${s.score}%`).join("\n") + "\n";
        }
        process.stdout.write(out);
        return 0;
      }

      if (args.fix) {
        const { results, totalChanges } = applyConsumerCodemod(merged, sources, adoptOptions);
        for (const r of results) {
          if (r.changes > 0) {
            writeFileSync(resolve(process.cwd(), r.file), r.text, "utf8");
          }
        }
        const after = lintConsumer(
          merged,
          results.map((r) => ({ file: r.file, text: r.text })),
          adoptOptions
        );
        console.log(
          `adopt --fix: rewrote ${totalChanges} literal(s); ${after.findings.length} remaining matchable usage(s)`
        );
        process.exitCode = after.findings.length > 0 ? 1 : 0;
        return process.exitCode;
      }

      const { findings } = lintConsumer(merged, sources, adoptOptions);
      for (const f of findings) {
        const kind = f.exact
          ? "exact"
          : `nearest (distance ${f.distance.toFixed(3)})`;
        process.stdout.write(
          `${f.file}:${f.line}:${f.column}: warning: hardcoded ${f.kind} '${f.value}' should use ${f.variable} [${kind}]\n`
        );
      }
      if (findings.length === 0) {
        process.stdout.write("adopt: no hardcoded token values found\n");
        return 0;
      }
      process.exitCode = 1;
      return 1;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "mcp") {
    try {
      if (!input) {
        console.error(
          "error: mcp requires a token file: token-to-css mcp <tokens.json> [--serve-url <url>]"
        );
        process.exitCode = 1;
        return 1;
      }
      const { merged } = loadLocated(rebuildPaths());
      const ctx = createMcpContext({ tokens: merged, serveUrl: args["serve-url"] || null });
      const { stdin, stdout } = process;
      let buffer = "";
      const onData = async (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          try {
            const response = await handleMcpMessage(message, ctx);
            if (response) stdout.write(JSON.stringify(response) + "\n");
          } catch (e) {
            stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id ?? null,
                error: { code: -32603, message: e.message },
              }) + "\n"
            );
          }
        }
      };
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "release") {
    try {
      const prevFile = input;
      const nextFile = args._[2];
      if (!prevFile || !nextFile) {
        console.error(
          "error: release requires two token files: token-to-css release <prev.json> <next.json> [--version x.y.z]"
        );
        process.exitCode = 1;
        return 1;
      }
      const prev = readTokensFile(prevFile);
      const next = readTokensFile(nextFile);
      const version = args.version || "0.0.0";
      const r = computeRelease(prev, next, { version });
      console.log(`bump: ${r.bump}  next version: ${r.nextVersion}`);
      console.log(`  removed: ${r.removed.length}  changed: ${r.changed.length}  added: ${r.added.length}`);
      if (args.changelog) {
        const cp = resolve(process.cwd(), args.changelog);
        const existing = existsSync(cp) ? readFileSync(cp, "utf8") : "";
        writeFileSync(cp, `${r.changelog}\n${existing}`, "utf8");
        console.error(`wrote changelog to ${cp}`);
      } else {
        process.stdout.write(`\n${r.changelog}`);
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "lock") {
    try {
      const lockFile = input;
      const prevFile = args._[2];
      const nextFile = args._[3];
      if (!lockFile || !prevFile || !nextFile) {
        console.error(
          "error: lock requires <lockfile.json> <prev.json> <next.json> [--version x.y.z]"
        );
        process.exitCode = 1;
        return 1;
      }
      const lock = readTokensFile(lockFile);
      const prev = readTokensFile(prevFile);
      const next = readTokensFile(nextFile);
      const version = args.version || null;
      const res = analyzeLockfile(lock, prev, next, version);
      console.log(`lockfile ${lock.name || "<unnamed>"} pinned ${lock.range || "*"}${version ? ` vs ${version}` : ""}`);
      console.log(`  in range: ${res.inRange}  ok: ${res.ok}`);
      for (const b of res.breaking) {
        console.log(`  ${b.type}: ${b.path}${b.type === "changed" ? ` (${b.from} -> ${b.to})` : ""}`);
      }
      process.exitCode = res.ok ? 0 : 1;
      return process.exitCode;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (sub === "bisect") {
    try {
      const tokenPath = input;
      const cpDir = args.checkpoints;
      if (!tokenPath || !cpDir) {
        console.error(
          "error: bisect requires a token path and --checkpoints <dir>: token-to-css bisect <token.path> --checkpoints <dir>"
        );
        process.exitCode = 1;
        return 1;
      }
      const dir = resolve(process.cwd(), cpDir);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
      const checkpoints = files.map((f) => ({
        id: f,
        tree: JSON.parse(readFileSync(joinPath(dir, f), "utf8")),
      }));
      const r = bisectToken(checkpoints, tokenPath);
      if (!r.found) {
        console.log(`bisect ${tokenPath}: no change across ${checkpoints.length} checkpoint(s)`);
        return 0;
      }
      console.log(`bisect ${tokenPath}: changed at ${r.id}`);
      console.log(renderSideBySide(tokenPath, r.from, r.to));
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return 1;
    }
  }

  const outputsList = collect(args.output || args.o);
  const configOutputs = collect(config.output);
  const allOutputs = parseOutputs([...configOutputs, ...outputsList], options.format);
  const outputs =
    allOutputs.length > 0
      ? allOutputs
      : [{ format: null, path: null }];

  const build = options.check ? checkAll : generateAll;
  let paths = rebuildPaths();
  const watch = Boolean(args.watch || args.w);
  let ok = true;
  if (!(watch && !options.initial)) {
    ok = build(paths, options, outputs);
  }

  if (watch) {
    const watched = new Set();
    const watchOne = (file) => {
      const rp = resolve(process.cwd(), file);
      if (watched.has(rp)) return;
      watched.add(rp);
      watchFile(rp, regenerate);
    };
    const regenerate = () => {
      paths = rebuildPaths();
      for (const f of paths) watchOne(f);
      const okNow = build(paths, options, outputs);
      if (okNow) process.exitCode = 0;
    };
    for (const f of paths) watchOne(f);
    for (const g of globs) {
      const base = globBaseDir(g);
      try {
        watch(base, { persistent: true, recursive: true }, regenerate);
      } catch {
        /* directory watching unsupported here */
      }
    }
    console.error(`watching ${[...watched].join(", ")} (ctrl+c to stop)`);
  }
  if (options.serve) {
    let explorerHtml = null;
    try {
      const { merged } = loadLocated(paths);
      explorerHtml = buildExplorerHTML(merged, {
        ...options,
        files: outputs.filter((o) => o.path).map((o) => ({ name: o.path.split(/[\\/]/).pop() })),
      });
    } catch {
      explorerHtml = null;
    }
    startServer(outputs, options.port, explorerHtml);
  }
  process.exitCode = ok ? 0 : 1;
}

run();
