#!/usr/bin/env node
import { readFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { resolve } from "node:path";
import { convert } from "./index.js";
import { deepMerge } from "./merge.js";
import { expandGlob } from "./glob.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      args._.push(a);
      continue;
    }
    const key = a.replace(/^-+/, "");
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      if (key === "import" || key === "i" || key === "glob" || key === "g") {
        if (!args[key]) args[key] = [];
        if (Array.isArray(args[key])) args[key].push(next);
        else args[key] = [args[key], next];
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
  -o, --output <file>   Write output to a file (default: stdout)
  -f, --format <name>   css | scss | barefoot  (default: css)
  -s, --selector <sel>  CSS selector for variables (default: :root)
  -t, --theme <name>    barefoot only: wrap in [data-bf-theme="name"]
  -m, --map <file>      barefoot only: JSON file mapping token names to vars
  -i, --import <file>   Merge additional token files (repeatable)
  -g, --glob <pattern>  Merge files matching a glob (repeatable)
  -c, --config <file>   Config file with default options (default: auto-detect)
  -w, --watch           Re-generate whenever an input file changes
  -R, --no-resolve      Do not resolve {token} references
  -n, --no-validate     Skip token validation
  -h, --help            Show help
`);
}

function readTokensFile(p) {
  return JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8"));
}

function loadMergedTokens(paths) {
  const merged = {};
  for (const p of paths) deepMerge(merged, readTokensFile(p));
  return merged;
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

function generate(paths, options, output) {
  try {
    if (options.mapPath) {
      options.map = JSON.parse(readFileSync(options.mapPath, "utf8"));
    }
    const tokens = loadMergedTokens(paths);
    const css = convert(tokens, options);
    if (output) {
      const outPath = resolve(process.cwd(), output);
      writeFileSync(outPath, css, "utf8");
      console.error(`wrote ${options.format} to ${outPath}`);
    } else {
      process.stdout.write(css);
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
  watch(source, { persistent: true }, fire);
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

  const configPath = findConfig(args.config || args.c);
  const config = loadConfig(configPath);
  if (configPath) console.error(`using config ${configPath}`);

  const imports = [
    ...collect(config.imports),
    ...collect(args.import || args.i),
  ];
  const globs = [...collect(config.glob), ...collect(args.glob || args.g)];
  const globFiles = globs.flatMap((g) => expandGlob(g));

  const input = args._[0];
  if (!input && imports.length === 0 && globFiles.length === 0) {
    console.error("error: no input file provided. Use --help for usage.");
    return 1;
  }

  const paths = [...(input ? [input] : []), ...imports, ...globFiles];

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
  options.validate = !(args["no-validate"] || args.n);

  const output = args.output || args.o || config.output;
  const ok = generate(paths, options, output);

  if (args.watch || args.w) {
    const watchPaths = paths.map((p) => resolve(process.cwd(), p));
    console.error(`watching ${watchPaths.join(", ")} (ctrl+c to stop)`);
    for (const file of watchPaths) {
      watchFile(file, () => {
        const okNow = generate(paths, options, output);
        if (okNow) process.exitCode = 0;
      });
    }
  }
  process.exitCode = ok ? 0 : 1;
}

run();
