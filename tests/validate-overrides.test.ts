import { describe, expect, it } from "vitest";
import { validateDocument } from "../src/core/validate";

/**
 * An override that cannot apply is a silent no-op: the document validates, the
 * canvas paints, and the one value the author meant to change is the one that
 * stays at the master's.
 */

const component = (id: string, name: string, children: unknown[]) => ({
  id,
  name,
  type: "component",
  x: 0,
  y: 0,
  width: 120,
  height: 40,
  children
});

const master = (children: unknown[]) => component("btn", "Button", children);

const icon = () =>
  component("icon", "Icon", [
    { id: "dot", type: "rect", x: 0, y: 0, width: 8, height: 8 },
    { id: "glyph", type: "text", x: 0, y: 0, width: 8, height: 8, content: "!" }
  ]);

const slots = [
  { id: "label", type: "text", x: 10, y: 10, width: 100, height: 20, content: "Buy" },
  { id: "plate", type: "rect", x: 0, y: 0, width: 120, height: 40 },
  { id: "icon_slot", type: "instance", componentId: "icon", x: 90, y: 12, width: 16, height: 16 }
];

const overrides = (list: unknown[]) => ({
  version: "0.1",
  pages: [
    {
      id: "page",
      name: "Page",
      children: [master(slots), icon(), { id: "inst", type: "instance", componentId: "btn", x: 20, y: 80, overrides: list }]
    }
  ]
});

const overrideFindings = (raw: unknown) =>
  validateDocument(raw as never).filter((d) => d.message.includes("can never apply"));

describe("an override that can never apply", () => {
  it("is named when its target is not in the master", () => {
    const [finding] = overrideFindings(
      overrides([{ targetId: "no_such_node", property: "content", value: "ignored" }])
    );
    expect(finding.elementId).toBe("inst");
    expect(finding.level).toBe("warning");
    expect(finding.message).toContain('targets "no_such_node", which is not a node inside master "Button"');
  });

  it("is named when its property is misspelled", () => {
    const [finding] = overrideFindings(overrides([{ targetId: "label", property: "colour", value: "#fff" }]));
    expect(finding.message).toContain('"colour" is not an overridable property');
  });

  it("is named when the target node cannot carry the property", () => {
    // `content` is a listed property; a rect has no text branch, so the
    // resolution drops it and the master's empty plate shows instead.
    const [finding] = overrideFindings(overrides([{ targetId: "plate", property: "content", value: "hi" }]));
    expect(finding.message).toContain('"content" cannot be carried by "plate" (rect)');
  });

  it("says nothing about an override the resolution will honour", () => {
    expect(
      overrideFindings(
        overrides([
          { targetId: "label", property: "content", value: "Buy now" },
          { targetId: "label", property: "fills", value: [] },
          { targetId: "plate", property: "fills", value: [] }
        ])
      )
    ).toEqual([]);
  });

  it("accepts the path form that addresses a node inside a nested instance", () => {
    expect(
      overrideFindings(
        overrides([
          { targetId: "icon_slot/dot", property: "fills", value: [] },
          { targetId: "icon_slot/glyph", property: "content", value: "★" }
        ])
      )
    ).toEqual([]);
  });

  it("is named when a path descends through something that is not an instance", () => {
    const [finding] = overrideFindings(
      overrides([{ targetId: "label/sub", property: "content", value: "deep" }])
    );
    expect(finding.message).toContain('"sub", but "label" is a text');
  });

  it("is named when the tail is not a node of the nested master", () => {
    const [finding] = overrideFindings(
      overrides([{ targetId: "icon_slot/nope", property: "fills", value: [] }])
    );
    expect(finding.message).toContain('"nope", which is not a node inside the nested master "Icon"');
  });

  it("grades the tail node, not the nested instance", () => {
    // `dot` is a rect: `content` lands on the instance's own override list and is
    // then skipped by the nested resolution — the same no-op, one level down.
    const [finding] = overrideFindings(
      overrides([{ targetId: "icon_slot/dot", property: "content", value: "x" }])
    );
    expect(finding.message).toContain('"content" cannot be carried by "dot" (rect)');
  });

  it("counts them per instance instead of one finding each", () => {
    const [finding] = overrideFindings(
      overrides([
        { targetId: "ghost", property: "content", value: "a" },
        { targetId: "label", property: "colour", value: "b" },
        { targetId: "label", property: "opacity", value: 0.5 }
      ])
    );
    expect(finding.message).toContain("2 override(s) that can never apply");
    expect(finding.message).toContain("ghost");
    expect(finding.message).not.toContain("opacity");
  });

  it("stays quiet when the instance has no master to address — that is its own error", () => {
    const raw = {
      version: "0.1",
      pages: [
        {
          id: "page",
          name: "Page",
          children: [
            { id: "inst", type: "instance", componentId: "missing", x: 0, y: 0, overrides: [{ targetId: "a", property: "content", value: "x" }] }
          ]
        }
      ]
    };
    const found = validateDocument(raw as never);
    expect(found.some((d) => d.message.includes("can never apply"))).toBe(false);
    expect(found.some((d) => d.level === "error" && d.message.includes("not in this document"))).toBe(true);
  });
});
