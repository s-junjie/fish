import { describe, expect, it } from "vitest";
import {
  COLOR_NAMES,
  DURATION_TOKENS,
  EASING_TOKENS,
  FLAT_COLOR_NAMES,
  RADIUS_TOKENS,
  SHADOW_TOKENS,
  color,
  cssVariables,
  duration,
  easing,
  radius,
  shadow
} from "../tailwind.tokens.js";

/**
 * The token module is the one place a value is allowed to live, and Tailwind
 * reads every utility through it. A missing variable does not fail the build —
 * it paints `rgb(var(--fish-…))` as an invalid colour and silently disappears.
 * These checks make a new token or a new category fail here instead.
 */
describe("design tokens compile to CSS variables", () => {
  const variables = cssVariables();

  it("defines a variable for every colour token", () => {
    for (const name of COLOR_NAMES) {
      expect(variables[`--fish-${name}`], name).toBeTruthy();
    }
  });

  it("keeps flat colours as channels so opacity modifiers still work", () => {
    for (const name of FLAT_COLOR_NAMES) {
      expect(variables[`--fish-${name}`], name).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it("only references variables that are defined", () => {
    for (const [name, value] of Object.entries(variables)) {
      for (const match of value.matchAll(/var\((--fish-[a-z0-9-]+)\)/g)) {
        expect(variables[match[1]], `${name} → ${match[1]}`).toBeTruthy();
      }
    }
  });

  it("variables every shape, depth and motion token", () => {
    for (const [name, value] of Object.entries(RADIUS_TOKENS)) {
      expect(variables[`--fish-radius-${name}`]).toBe(value);
    }
    for (const [name, value] of Object.entries(SHADOW_TOKENS)) {
      expect(variables[`--fish-shadow-${name}`]).toBe(value);
    }
    for (const [name, value] of Object.entries(DURATION_TOKENS)) {
      expect(variables[`--fish-duration-${name}`]).toBe(value);
    }
    for (const [name, value] of Object.entries(EASING_TOKENS)) {
      expect(variables[`--fish-ease-${name}`]).toBe(value);
    }
  });

  it("uses the variable form in Tailwind's theme", () => {
    expect(color("panel")).toBe("rgb(var(--fish-panel) / <alpha-value>)");
    expect(color("brand-wash")).toBe("var(--fish-brand-wash)");
    expect(radius("panel")).toBe("var(--fish-radius-panel)");
    expect(shadow("popover")).toBe("var(--fish-shadow-popover)");
    expect(duration("base")).toBe("var(--fish-duration-base)");
    expect(easing("snap")).toBe("var(--fish-ease-snap)");
  });
});
