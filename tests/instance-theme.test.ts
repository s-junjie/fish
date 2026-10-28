import { describe, expect, it } from "vitest";
import { resolveInstanceContent } from "../src/core/interactions/instance-resolve";
import { resolveInstanceBox } from "../src/core/interactions/instance-inherit";
import type { ComponentElement, ColorToken, InstanceElement } from "../src/core/dsl/types";
import type { StyleTables } from "../src/core/interactions/style-tables";

const tokens: ColorToken[] = [
  { id: "tok_shell", name: "shell", type: "color", value: "#FFFFFF", modes: { dark: "#161618" } },
  { id: "tok_ink", name: "ink", type: "color", value: "#161614", modes: { dark: "#F2F0EA" } },
  { id: "tok_hairline", name: "hairline", type: "color", value: "#FFFFFF80", modes: { dark: "#FFFFFF40" } },
  { id: "tok_shadow", name: "shadow", type: "color", value: "#00000026", modes: { dark: "#00000066" } }
];

const tables: StyleTables = { tokens, styles: [] };

const master: ComponentElement = {
  id: "cmp/icon",
  type: "component",
  name: "Icon",
  x: 0,
  y: 0,
  width: 44,
  height: 44,
  fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_shell" }],
  strokes: [{ color: "#FFFFFF80", width: 1, style: "solid", align: "inside", tokenId: "tok_hairline" }],
  effects: [
    {
      type: "drop-shadow",
      color: "#00000026",
      offset: { x: 0, y: 2 },
      blur: 8,
      tokenId: "tok_shadow",
      enabled: true
    }
  ],
  children: [
    {
      id: "glyph",
      type: "rect",
      x: 10,
      y: 10,
      width: 24,
      height: 24,
      fills: [{ type: "solid", color: "#161614", tokenId: "tok_ink" }]
    }
  ]
};

const instance: InstanceElement = {
  id: "inst/icon",
  type: "instance",
  componentId: master.id,
  x: 100,
  y: 100,
  width: 44,
  height: 44
};

const fillOf = (el: { fills?: { type: string; color?: string }[] } | undefined) =>
  el?.fills?.[0]?.color;

describe("instance content resolves its master's tokens under the rendered theme", () => {
  it("keeps the light token values when no theme is supplied", () => {
    const content = resolveInstanceContent(instance, master);
    expect(fillOf(content.children[0] as any)).toBe("#161614");
  });

  it("resolves a child's token-bound fill for a dark render", () => {
    const content = resolveInstanceContent(instance, master, { theme: "dark", tables });
    expect(fillOf(content.children[0] as any)).toBe("#F2F0EA");
  });

  it("resolves the instance box's own token-bound fill for a dark render", () => {
    const box = resolveInstanceBox(instance, master, undefined, { theme: "dark", tables });
    expect((box.fills[0] as any).color).toBe("#161618");
  });

  it("resolves the instance box's stroke and shadow tokens for a dark render", () => {
    const box = resolveInstanceBox(instance, master, undefined, { theme: "dark", tables });
    expect(box.strokes[0].color).toBe("#FFFFFF40");
    expect((box.effects[0] as any).color).toBe("#00000066");
  });

  it("does not mutate the master's stored light values", () => {
    resolveInstanceContent(instance, master, { theme: "dark", tables });
    resolveInstanceBox(instance, master, undefined, { theme: "dark", tables });
    expect((master.fills?.[0] as any)?.color).toBe("#FFFFFF");
    expect((master.children?.[0] as any).fills?.[0]?.color).toBe("#161614");
  });
});
