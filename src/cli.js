#!/usr/bin/env node
import { readFileSync, writeFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import { convert } from "./index.js";

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
      args[key] = next;
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
  -w, --watch           Re-generate whenever the input file changes
  -R, --no-resolve      Do not resolve {token} references
  -n, --no-validate     Skip token validation
  -h, --help            Show help
`);
}

function generate(source, options, output) {
  try {
    if (options.mapPath) {
      options.map = JSON.parse(readFileSync(options.mapPath, "utf8"));
    }
    const tokens = JSON.parse(readFileSync(source, "utf8"));
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

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const input = args._[0];
  if (!input) {
    console.error("error: no input file provided. Use --help for usage.");
    return 1;
  }
  const source = resolve(process.cwd(), input);
  const options = { format: args.format || args.f || "css" };
  if (args.selector || args.s) options.selector = args.selector || args.s;
  if (args.theme || args.t) options.theme = args.theme || args.t;
  if (args.map || args.m) {
    options.mapPath = resolve(process.cwd(), args.map || args.m);
  }
  const output = args.output || args.o;
  if (args["no-resolve"] === undefined && args.R === undefined) {
    options.resolve = true;
  } else {
    options.resolve = false;
  }
  options.validate = !(args["no-validate"] || args.n);
  const ok = generate(source, options, output);
  if (args.watch || args.w) {
    console.error(`watching ${source} (ctrl+c to stop)`);
    watchFile(source, () => {
      const okNow = generate(source, options, output);
      if (okNow) process.exitCode = 0;
    });
  }
  process.exitCode = ok ? 0 : 1;
}

run();
