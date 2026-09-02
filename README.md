# token-to-css

> Convert a design token JSON file into framework-agnostic CSS. Generates CSS custom properties by default, with support for SCSS variables and a barefoot-css flavored output.

[![npm version](https://img.shields.io/npm/v/token-to-css)](https://www.npmjs.com/package/token-to-css)
[![npm downloads](https://img.shields.io/npm/dm/token-to-css)](https://www.npmjs.com/package/token-to-css)
[![CI](https://img.shields.io/github/actions/workflow/status/coffeetocoffee/token-to-css/test.yml)](https://github.com/coffeetocoffee/token-to-css/actions)
[![v0.2.0](https://img.shields.io/badge/phase-0.2.0%20%E2%80%94%20multi--file%20tokens-2b7a4f)](https://github.com/coffeetocoffee/token-to-css)
[![MIT license](https://img.shields.io/npm/l/token-to-css)](LICENSE)

## Install

```bash
npm install -g token-to-css
```

Or run directly with Node 18+:

```bash
node src/cli.js tokens.json -o output.css
```

## Usage

```bash
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
  -w, --watch           Re-generate whenever the input file changes
  -R, --no-resolve      Do not resolve {token} references
  -n, --no-validate     Skip token validation
  -h, --help            Show help
```

Watch mode regenerates the output on every save:

```bash
token-to-css tokens.json -o theme.css -w
```

## Multi-file tokens

Merge additional files with `--import` (repeatable). Later files override
earlier, the main input wins last:

```bash
token-to-css tokens.json --import colors.json --import spacing.json -o theme.css
```

Glob patterns are also supported via `--glob` (repeatable):

```bash
token-to-css --glob "src/**/*.tokens.json" -o theme.css
```

## Config file

Place `token-to-css.config.json` (or `.token-to-cssrc`) in the project root
to set defaults:

```json
{
  "format": "barefoot",
  "theme": "brand",
  "imports": ["colors.json", "spacing.json"]
}
```

CLI flags override config. Watch mode also watches imported files.

## Barefoot-css preset

The `barefoot` format maps common token names onto barefoot-css's semantic
`--bf-*` variables, so your design tokens become a drop-in theme:

```bash
token-to-css tokens.json -f barefoot -t brand -o brand-theme.css
```

```css
/* barefoot-css theme tokens */
[data-bf-theme="brand"] {
  --bf-primary: #3b82f6;
  --bf-surface: #ffffff;
  --bf-text: #0f172a;
  /* ... */
}
```

Load it by setting the attribute on `<html>`:

```html
<html data-bf-theme="brand">
```

### Custom mapping

Your token names don't match the built-ins? Pass a map file with
`--map` (flat token name → CSS variable). Custom entries override the
built-in table.

`map.json`:

```json
{
  "brand": "--bf-primary",
  "canvas": "--bf-surface",
  "ink": "--bf-text"
}
```

```bash
token-to-css tokens.json -f barefoot -m map.json -o theme.css
```

Any token not found in the map falls back to `--bf-<name>`.

Mapping highlights (anything unrecognized falls back to `--bf-<name>`):

| Token path            | barefoot variable     |
| --------------------- | --------------------- |
| `color.primary`       | `--bf-primary`        |
| `color.background`    | `--bf-surface`        |
| `color.text`          | `--bf-text`           |
| `color.danger`        | `--bf-danger`         |
| `radius` / `radius-sm`| `--bf-radius` / `--bf-radius-sm` |
| `spacing.4`           | `--bf-space-4`        |
| `font.family`         | `--bf-font`           |
| `shadow`              | `--bf-shadow`         |

## Tests

```bash
npm test
```

## Example

`tokens.json`:

```json
{
  "color": { "primary": "#3b82f6" },
  "spacing": { "md": "1rem" }
}
```

```bash
token-to-css tokens.json -f css
```

```css
:root {
  --color-primary: #3b82f6;
  --spacing-md: 1rem;
}
```

## Token format

Any nested JSON object. Keys are flattened into kebab-case variable names:

- `color.primary` -> `--color-primary`
- `font.size.lg` -> `--font-size-lg`

### References

String values can reference other tokens with `{dotted.path}`. Spaced
arithmetic (`+ - * /`) is emitted as `calc()`:

```json
{
  "spacing": { "md": "1rem" },
  "gap": "{spacing.md} * 1.5"
}
```

```css
:root {
  --spacing-md: 1rem;
  --gap: calc(1rem * 1.5);
}
```

References are resolved recursively and validated (unknown/cirular refs error
out). Disable with `--no-resolve`.

### Validation

Input is validated against `schema/tokens.schema.json` before conversion:
groups must be objects, leaves must be strings/numbers/booleans, and every
`{reference}` must resolve. Invalid input exits non-zero with a message. Skip
with `--no-validate`.

## Library use

```js
import { convert } from "token-to-css";
import { validateTokens } from "token-to-css/schema.js";
import tokens from "./tokens.json" assert { type: "json" };

validateTokens(tokens);
const css = convert(tokens, { format: "barefoot" });
```
