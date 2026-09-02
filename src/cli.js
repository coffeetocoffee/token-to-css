#!/usr/bin/env node
import { readFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { convert, convertToMap, diffTokens } from "./index.js";
import { deepMerge } from "./merge.js";
import { expandGlob, globBaseDir } from "./glob.js";
import { parseLocated } from "./locate.js";

const REPEATABLE = new Set(["import", "i", "glob", "g", "output", "o", "mode"]);

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

Options:
  -o, --output <[fmt:]file>  Write output (repeatable); prefix format, e.g. scss:out.scss
  -f, --format <name>   css | scss | barefoot | css-modules | json | tailwind | style-dictionary | schema | report  (default: css)
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
  --strict              Fail on arithmetic with mismatched units (no calc() fallback)
  --diff <a> <b>       Print a token diff report for two token files, then exit
  --serve              Serve generated outputs on a local HTTP server (with -w)
  --port <n>           Port for --serve (default: 4173)
  -n, --no-validate     Skip token validation
  -h, --help            Show help
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

function loadConfig(configPath) {
  if (!configPath) return {};
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function parseOutputs(list, defaultFormat) {
  return list.map((spec) => {
    const m = /^([a-z-]+):(.+)$/i.exec(spec);
    if (
      m &&
      [
        "css",
        "scss",
        "barefoot",
        "css-modules",
        "json",
        "tailwind",
        "style-dictionary",
        "schema",
        "report",
      ].includes(m[1].toLowerCase())
    ) {
      return { format: m[1].toLowerCase(), path: m[2] };
    }
    return { format: null, path: spec };
  });
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
        writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf8");
        const base = out.path.split(/[\\/]/).pop();
        writeFileSync(
          resolve(process.cwd(), out.path),
          `${css}/*# sourceMappingURL=${base}.map */\n`,
          "utf8"
        );
        console.error(`wrote ${format} to ${resolve(process.cwd(), out.path)}`);
      } else {
        const css = convert(merged, { ...options, format });
        if (out.path) {
          const outPath = resolve(process.cwd(), out.path);
          writeFileSync(outPath, css, "utf8");
          console.error(`wrote ${format} to ${outPath}`);
        } else {
          process.stdout.write(css);
        }
      }
    }
    return true;
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
  const w = watch(source, { persistent: true }, fire);
  w.on("error", () => {});
}

function startServer(outputs, port) {
  const files = outputs
    .filter((o) => o.path)
    .map((o) => ({
      path: resolve(process.cwd(), o.path),
      name: o.path.split(/[\\/]/).pop(),
      format: o.format || "css",
    }));
  const ct = (f) =>
    f && (f.format === "json" || f.format === "schema" || f.format === "style-dictionary" || f.format === "report")
      ? "application/json"
      : "text/css";
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const items = files.length
        ? files.map((f) => `<li><a href="/${encodeURIComponent(f.name)}">${f.name}</a></li>`).join("")
        : "<li>(no file outputs; use -o path)</li>";
      res.end(`<h1>token-to-css</h1><ul>${items}</ul>`);
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
  const config = loadConfig(configPath);
  if (configPath) console.error(`using config ${configPath}`);

  const imports = [
    ...collect(config.imports),
    ...collect(args.import || args.i),
  ];
  const globs = [...collect(config.glob), ...collect(args.glob || args.g)];

  const input = args._[0];
  if (!input && imports.length === 0 && globs.length === 0 && !args.stdin) {
    console.error("error: no input file provided. Use --help for usage.");
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
  options.port = args.port || args.p || config.port || 4173;
  options.stdin = Boolean(args.stdin);
  if (options.stdin) options.stdinText = readStdinSync();
  options.initial = args.initial !== "false";

  const outputsList = collect(args.output || args.o);
  const configOutputs = collect(config.output);
  const allOutputs = parseOutputs([...configOutputs, ...outputsList], options.format);
  const outputs =
    allOutputs.length > 0
      ? allOutputs
      : [{ format: null, path: null }];

  const rebuildPaths = () => [
    ...(input ? [input] : []),
    ...imports,
    ...globs.flatMap((g) => expandGlob(g)),
  ];

  let paths = rebuildPaths();
  const watch = Boolean(args.watch || args.w);
  let ok = true;
  if (!(watch && !options.initial)) {
    ok = generateAll(paths, options, outputs);
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
      const okNow = generateAll(paths, options, outputs);
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
  if (options.serve) startServer(outputs, options.port);
  process.exitCode = ok ? 0 : 1;
}

run();
