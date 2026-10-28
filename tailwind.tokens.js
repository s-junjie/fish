/**
 * The design tokens, and the CSS custom properties they compile to.
 *
 * `tailwind.config.js` maps every utility to one of these `--fish-*` variables
 * and emits the `:root` block from this module. Keeping the values here means a
 * plugin built outside this repository can reference the variable instead of a
 * frozen hex value, and a theme change reaches it without a rebuild.
 *
 * Flat colours are stored as space-separated channels so Tailwind's `<alpha>`
 * placeholder (and therefore `/NN` utilities) still works. Translucent tokens
 * are stored as complete colours; they do not accept an opacity modifier.
 */

export const COLOR_TOKENS = {
  paper: "#101010",
  panel: "#181818",
  surface: "#1E1E20",
  raised: "#242428",
  field: "#242424",
  "field-active": "#343434",
  inset: "#0A0A0A",
  rule: "#242428",
  "rule-strong": "#333338",
  ink: { DEFAULT: "#ECF3F8", dim: "#9BA4AB", muted: "#666C70" },
  "swatch-ring": "rgba(255,255,255,.16)",
  brand: "#E8A33D",
  "brand-wash": { from: "brand", alpha: 0.12 },
  "brand-ink": "#2A1D08",
  "brand-ink-soft": "#503813",
  "canvas-select": "#1B72FF",
  component: "#B794FF",
  coral: "#FF5353",
  "snap-pink": "#FF5353",
  "measure-coral": "#FF5353",
  selection: { from: "brand", alpha: 0.12 },
  "selection-hover": { from: "brand", alpha: 0.18 },
  "selection-subtree": { from: "brand", alpha: 0.04 },
  "selection-solid": "#31291C",
  "selection-subtree-solid": "#201D19",
  "selection-subtree-hover-solid": "#44351F",
  "paint-row-rule": "#242428",
  "paint-row-rule-open": "#4A4A52"
};

export const RADIUS_TOKENS = {
  panel: "9px",
  ctl: "4px",
  swatch: "3px",
  pill: "6px",
  dock: "14px",
  "dock-ctl": "10px"
};

export const SHADOW_TOKENS = {
  panel: "0 1px 2px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.34)",
  popover: "0 1px 2px rgba(0,0,0,.45), 0 12px 34px rgba(0,0,0,.46)",
  modal: "0 2px 6px rgba(0,0,0,.5), 0 24px 60px rgba(0,0,0,.55)"
};

export const DURATION_TOKENS = {
  micro: "120ms",
  base: "180ms",
  slide: "260ms",
  pulse: "1.4s"
};

export const EASING_TOKENS = {
  snap: "cubic-bezier(.2, 0, 0, 1)",
  slide: "cubic-bezier(.32, .72, 0, 1)",
  soft: "cubic-bezier(.4, 0, .6, 1)"
};

const HEX_SHORT = /^#[0-9a-f]{3}$/i;
const HEX_FLAT = /^#[0-9a-f]{6}$/i;
const HEX_ALPHA = /^#([0-9a-f]{6})([0-9a-f]{2})$/i;
const RGB_FN = /^rgba?\(([^)]+)\)$/i;

function channels(hex) {
  const value = HEX_SHORT.test(hex)
    ? hex.slice(1).split("").map((c) => c + c).join("")
    : hex.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function fullColor(value) {
  const alphaHex = HEX_ALPHA.exec(value);
  if (alphaHex) {
    const alpha = (parseInt(alphaHex[2], 16) / 255).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return `rgb(${channels(`#${alphaHex[1]}`)} / ${alpha})`;
  }
  const fn = RGB_FN.exec(value);
  if (!fn) return value;
  const [r, g, b, a] = fn[1].split(",").map((part) => part.trim());
  return a === undefined ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${a})`;
}

function isFlat(value) {
  return typeof value === "string" && (HEX_SHORT.test(value) || HEX_FLAT.test(value));
}

function resolveTokens(tokens, prefix = [], out = {}) {
  for (const [key, value] of Object.entries(tokens)) {
    const name = key === "DEFAULT" ? prefix.join("-") : [...prefix, key].join("-");
    if (value && typeof value === "object" && !("from" in value)) {
      resolveTokens(value, [...prefix, key], out);
    } else {
      out[name] = value;
    }
  }
  return out;
}

const RESOLVED_TOKENS = resolveTokens(COLOR_TOKENS);

export const COLOR_NAMES = Object.keys(RESOLVED_TOKENS);
export const FLAT_COLOR_NAMES = COLOR_NAMES.filter((name) => isFlat(RESOLVED_TOKENS[name]));

function valueOf(name) {
  const value = RESOLVED_TOKENS[name];
  if (value === undefined) throw new Error(`Unknown colour token "${name}"`);
  return value;
}

export function color(name) {
  return isFlat(valueOf(name))
    ? `rgb(var(--fish-${name}) / <alpha-value>)`
    : `var(--fish-${name})`;
}

function cssColor(name, value) {
  if (isFlat(value)) return channels(value);
  if (typeof value === "string") return fullColor(value);
  if (value && typeof value === "object" && "from" in value) {
    return `rgb(var(--fish-${value.from}) / ${value.alpha})`;
  }
  throw new Error(`Unknown colour token shape for "${name}"`);
}

export function radius(name) {
  return `var(--fish-radius-${name})`;
}

export function shadow(name) {
  return `var(--fish-shadow-${name})`;
}

export function duration(name) {
  return `var(--fish-duration-${name})`;
}

export function easing(name) {
  return `var(--fish-ease-${name})`;
}

export function cssVariables() {
  const variables = {};
  for (const name of COLOR_NAMES) {
    variables[`--fish-${name}`] = cssColor(name, RESOLVED_TOKENS[name]);
  }
  for (const [name, value] of Object.entries(RADIUS_TOKENS)) {
    variables[`--fish-radius-${name}`] = value;
  }
  for (const [name, value] of Object.entries(SHADOW_TOKENS)) {
    variables[`--fish-shadow-${name}`] = value;
  }
  for (const [name, value] of Object.entries(DURATION_TOKENS)) {
    variables[`--fish-duration-${name}`] = value;
  }
  for (const [name, value] of Object.entries(EASING_TOKENS)) {
    variables[`--fish-ease-${name}`] = value;
  }
  return variables;
}
