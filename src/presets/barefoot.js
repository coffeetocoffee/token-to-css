import { flattenTokens } from "../index.js";

export const BAREFOOT_MAP = {
  "color-primary": "--bf-primary",
  "color-primary-hover": "--bf-primary-hover",
  "color-primary-fg": "--bf-primary-fg",
  "color-background": "--bf-surface",
  "color-surface": "--bf-surface",
  "color-surface-alt": "--bf-surface-alt",
  "color-text": "--bf-text",
  "color-muted": "--bf-muted",
  "color-border": "--bf-border",
  "color-danger": "--bf-danger",
  "color-danger-fg": "--bf-danger-fg",
  "color-success": "--bf-success",
  "color-success-fg": "--bf-success-fg",
  "color-info": "--bf-info",
  "color-info-fg": "--bf-info-fg",
  "color-warning": "--bf-warning",
  "color-warning-fg": "--bf-warning-fg",
  "radius": "--bf-radius",
  "radius-sm": "--bf-radius-sm",
  "radius-lg": "--bf-radius-lg",
  "radius-full": "--bf-radius-full",
  "radius-pill": "--bf-radius-full",
  "shadow": "--bf-shadow",
  "shadow-sm": "--bf-shadow-sm",
  "shadow-lifted": "--bf-shadow-lifted",
  "font-family": "--bf-font",
  "font-family-sans": "--bf-font",
  "font-family-mono": "--bf-font-mono",
  "font-size-xs": "--bf-type-xs",
  "font-size-sm": "--bf-type-sm",
  "font-size-base": "--bf-type-base",
  "font-size-md": "--bf-type-md",
  "font-size-lg": "--bf-type-lg",
  "font-size-xl": "--bf-type-xl",
  "font-size-2xl": "--bf-type-2xl",
  "transition": "--bf-transition",
  "transition-slow": "--bf-transition-slow",
  "content-width": "--bf-content-width",
  "max-width": "--bf-max-width",
  "control-height": "--bf-control-height",
};

export function mapToBarefoot(flat, customMap = {}) {
  const merged = { ...BAREFOOT_MAP, ...customMap };
  const out = {};
  for (const [name, value] of Object.entries(flat)) {
    if (merged[name]) {
      out[merged[name]] = value;
      continue;
    }
    const space = name.match(/^spacing-(\d+)$/);
    if (space) {
      out[`--bf-space-${space[1]}`] = value;
      continue;
    }
    out[`--bf-${name}`] = value;
  }
  return out;
}
