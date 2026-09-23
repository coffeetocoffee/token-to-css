<div align="center">

# 🎨 token-to-css

**Design tokens in. Everything out.**

Zero deps · Node 20+ · CSS, themes, docs & a live mesh — from one JSON file.

[![npm version](https://img.shields.io/npm/v/token-to-css)](https://www.npmjs.com/package/token-to-css)
[![GitHub Release](https://img.shields.io/github/v/release/coffeetocoffee/token-to-css)](https://github.com/coffeetocoffee/token-to-css/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/coffeetocoffee/token-to-css/test.yml)](https://github.com/coffeetocoffee/token-to-css/actions)
[![v15.0.0](https://img.shields.io/badge/phase-15.0.0%20%E2%80%94%20AI%20native%20token%20ops-7c3aed)](https://github.com/coffeetocoffee/token-to-css)
[![MIT license](https://img.shields.io/npm/l/token-to-css)](LICENSE)

</div>

<br>

```bash
npx token-to-css tokens.json -o theme.css
```

That's the whole core. Everything else is opt-in. ✨

<br>

## Try it

```json
// tokens.json
{ "color": { "primary": "#3b82f6" }, "spacing": { "md": "1rem" } }
```

```bash
npm install -D token-to-css
token-to-css tokens.json -f css
```

```css
/* theme.css */
:root {
  --color-primary: #3b82f6;
  --spacing-md: 1rem;
}
```

<br>

## Why people stay

- 🔗 **Refs just work** — `{color.primary}`, `{spacing.md} * 2`, `lighten()`, `oklch()` straight in JSON
- 🌓 **Themes for free** — `modes` / `brands` keys become `[data-mode]` / `[data-brand]` blocks
- 🔄 **Never locked in** — `reverse` CSS back to tokens, lossless with `--registry`
- 🛡️ **Safe to evolve** — version, deprecate, codemod renames, catch hardcoded values

<br>

## One source, any output

`css` · `scss` · `tailwind` · `ts` / `js` · `json` · `docs` · `figma` · `storybook` · `cms` · `flutter` · `compose` · +7 more

```bash
token-to-css tokens.json -o css:theme.css -o ts:tokens.ts -o docs:site/
token-to-css kit tokens.json --out-dir dist       # css + runtime + types + preview (+ components.css with --components)
token-to-css serve tokens.json --port 4173        # live REST + SSE + visual editor
```

See all formats + flags with `token-to-css --help`.

<br>

<details>
<summary><b>Go deeper — server, editor, governance & more</b></summary>

<br>

**Token files** — nested JSON, kebab-case vars (`color.primary` → `--color-primary`). W3C `$value` / `$type` auto-detected. Refs + spaced math collapse to values or `calc()`.

**Build** — `--import` / `--glob` / `--stdin` / `-w` watch · config in `token-to-css.config.json` · `lint` + `--contract` + `--check` + `--diff` for CI · `--source-map` + `--source-comments` for traceability.

**Server & editor** — `serve` gives REST (`GET /tokens`), SSE (`/events`), `POST /tokens` two-way, `--auth`, `--canary`, `--approve` change-requests, team rooms, `--relay` org mesh, connectors (`GET/POST /connectors`). Visual editor at `GET /editor` with diff-before-commit + semver verdict.

**Playground** — `playground` for hosted sessions, `playground --static` for a browser-only build. AI agents talk to tokens via `token-to-css mcp` — batch change-requests, migration codemods, `suggest-name`/`group-tokens` sampling, token search, and `/explain` provenance.

**Mesh** — `federate` teams + cross-org releases · `migrate` + `govern` renames with impact graph · `adopt --fix` rewrites hardcoded values · `release` / `lock` / `bisect` for semver + time travel · `registerConnector` / `registerFormat` / `registerFunction` plugins · slim installs via `@token-to-css/core` + `@token-to-css/connectors`.

Full reference lives in the CLI itself — `token-to-css <command> --help` is always current.

</details>

<br>

## $expand: generate tokens at compile time

Declare patterns once, emit families automatically:

- **ramp** — perceptual color scales (OKLCH lightness steps)
- **scale** — geometric progressions (spacing, type scale)
- **fluid** — viewport interpolation (clamp() between min/max)
- **cross** — cartesian products with placeholders (component variants)

### Color ramps

```json
{
  "color": {
    "brand": {
      "$value": "#3b82f6",
      "$expand": {
        "ramp": {
          "base": "#3b82f6",
          "light": [20, 80],
          "steps": [100, 200, 300, 400, 500, 600, 700],
          "chroma": 1.2
        }
      }
    }
  }
}
```

Generates `color.brand.100` through `color.brand.700` using OKLCH for perceptual uniformity.

### Scales & spacing

```json
{
  "spacing": {
    "$expand": {
      "scale": {
        "base": 4,
        "ratio": 1.5,
        "steps": ["xs", "sm", "md", "lg", "xl", "xxl"],
        "unit": "px"
      }
    }
  }
}
```

Creates `spacing.xs`, `spacing.sm`, ... as `4px`, `6px`, `9px`, etc.

### Fluid typography

```json
{
  "font": {
    "size": {
      "$expand": {
        "fluid": {
          "property": "fontSize",
          "min": 14,
          "max": 24,
          "vwMin": 320,
          "vwMax": 1200
        }
      },
      "display": {
        "$expand": {
          "fluid": {
            "property": "fontSize",
            "min": 32,
            "max": 64,
            "vwMin": 480,
            "vwMax": 1600
          }
        }
      }
    }
  }
}
```

Outputs CSS `font-size: clamp(14px, 2vw + 10px, 24px)` style formulas.

### Component cross-products

```json
{
  "button": {
    "$expand": {
      "cross": {
        "variant": ["primary", "secondary", "ghost"],
        "size": ["sm", "md", "lg"]
      },
      "template": {
        "bg": "{color.{variant}}",
        "pad": "{spacing.{size}}",
        "radius": "{radius-md}"
      }
    }
  }
}
```

Produces `button.primary-sm`, `button.secondary-md`, `button.ghost-lg`, each with template vars that resolve downstream.

### CLI usage

```bash
# Expand only, output JSON with generated token provenance
token-to-css tokens.json --generators --as-json

# Full build with expansion before refs/themes
token-to-css tokens.json -o css:theme.css
```

### API

```js
import { expandTokens } from "token-to-css";
const { tokens, generated } = expandTokens(input);
// generated: [{ path, name, kind, provenance, semver }]
```

<br>

```bash
npm test  # node --test
```

<div align="center">

MIT © coffeetocoffee · [Issues](https://github.com/coffeetocoffee/token-to-css/issues) · [Releases](https://github.com/coffeetocoffee/token-to-css/releases) · [Changelog](./CHANGELOG.md)

Made with ☕ — tokens in, systems out.

</div>
