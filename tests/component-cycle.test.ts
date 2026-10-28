import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import type { DesignDocument, DesignElement, InstanceElement } from "../src/core/dsl/types";
import { detachInstance } from "../src/core/interactions/component-ops";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import { resolveInstanceChildren } from "../src/core/interactions/instance-resolve";
import { validateDocument } from "../src/core/validate";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

const canvas = { width: 1200, height: 800, background: { type: "solid" as const, color: "#101010" }, unit: "px" as const };
const docOf = (elements: DesignElement[]): DesignDocument => ({
  version: "0.1", id: "doc", name: "Doc",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  canvas, pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }], activePageId: "page_1", elements
});

/** m1 uses m2, m2 uses m1. Unreachable from any UI, trivial to write by hand. */
const cyclic = (): DesignDocument =>
  docOf([
    { id: "m1", type: "component", name: "m1", x: 0, y: 0, width: 100, height: 100,
      children: [
        { id: "m1_label", type: "text", name: "m1_label", x: 4, y: 4, width: 40, height: 20, content: "one",
          style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" } },
        { id: "i1", type: "instance", name: "i1", componentId: "m2", x: 0, y: 40, width: 50, height: 50 }
      ] } as DesignElement,
    { id: "m2", type: "component", name: "m2", x: 200, y: 0, width: 100, height: 100,
      children: [{ id: "i2", type: "instance", name: "i2", componentId: "m1", x: 0, y: 0, width: 50, height: 50 }] } as DesignElement,
    { id: "root", type: "instance", name: "root", componentId: "m1", x: 400, y: 0, width: 100, height: 100 }
  ]);

/** Two masters sharing a third is a diamond, not a loop. */
const diamond = (): DesignDocument =>
  docOf([
    { id: "leaf", type: "component", name: "leaf", x: 0, y: 0, width: 20, height: 20,
      children: [{ id: "g", type: "rect", name: "g", x: 0, y: 0, width: 5, height: 5 }] } as DesignElement,
    { id: "left", type: "component", name: "left", x: 0, y: 100, width: 40, height: 40,
      children: [{ id: "l", type: "instance", name: "l", componentId: "leaf", x: 0, y: 0, width: 20, height: 20 }] } as DesignElement,
    { id: "right", type: "component", name: "right", x: 0, y: 200, width: 40, height: 40,
      children: [{ id: "r", type: "instance", name: "r", componentId: "leaf", x: 0, y: 0, width: 20, height: 20 }] } as DesignElement,
    { id: "both", type: "component", name: "both", x: 0, y: 300, width: 60, height: 40,
      children: [
        { id: "bl", type: "instance", name: "bl", componentId: "left", x: 0, y: 0, width: 40, height: 40 },
        { id: "br", type: "instance", name: "br", componentId: "right", x: 0, y: 0, width: 40, height: 40 }
      ] } as DesignElement,
    { id: "inst", type: "instance", name: "inst", componentId: "both", x: 400, y: 0, width: 60, height: 40 }
  ]);

describe("a master that reaches itself stops instead of recursing forever", () => {
  it("the render descent terminates", () => {
    const d = cyclic();
    let depth = 0;
    const descend = (inst: InstanceElement) => {
      const m = findMasterComponent(d, inst.componentId);
      if (!m) return;
      for (const c of resolveInstanceChildren(inst, m)) if (c.type === "instance") { depth++; descend(c as InstanceElement); }
    };
    descend(getActivePage(d).children[2] as InstanceElement);
    console.log("descent depth:", depth);
    expect(depth).toBeLessThan(10);
  });

  it("it still paints the part that is not in the loop", () => {
    const d = cyclic();
    const root = getActivePage(d).children[2] as InstanceElement;
    const kids = resolveInstanceChildren(root, findMasterComponent(d, "m1")!);
    console.log("m1's children:", kids.map((k) => `${k.id}:${k.type}`));
    expect(kids.map((k) => k.id)).toEqual(["root_m1_label", "root_i1"]);
  });

  it("validate names both masters in the loop", () => {
    const issues = validateDocument(cyclic()).filter((d) => d.message.includes("uses itself"));
    console.log(issues.map((i) => `${i.level} ${i.elementId}: ${i.message.slice(0, 60)}`));
    expect(issues.map((i) => i.elementId).sort()).toEqual(["m1", "m2"]);
  });

  it("a diamond is not a loop", () => {
    const issues = validateDocument(diamond()).filter((d) => d.message.includes("uses itself"));
    console.log("diamond issues:", issues.length);
    expect(issues).toEqual([]);
    const d = diamond();
    const inst = getActivePage(d).children[4] as InstanceElement;
    const kids = resolveInstanceChildren(inst, findMasterComponent(d, "both")!);
    expect(kids.map((k) => k.id)).toEqual(["inst_bl", "inst_br"]);
  });

  it("the chain marker is derived, not stored", () => {
    const d = normalizeDesignDocument(JSON.parse(JSON.stringify(cyclic())));
    const raw = JSON.stringify(d);
    console.log("__masterChain persisted:", raw.includes("__masterChain"), "| __instanceId persisted:", raw.includes("__instanceId"));
    expect(raw).not.toContain("__masterChain");
  });

  it("detach still produces real nodes", () => {
    const d = cyclic();
    const { doc: next, frame } = detachInstance(d, "root", findMasterComponent(d, "m1")!);
    const raw = JSON.stringify(next);
    console.log("detached frame:", frame?.id, "| markers left:", raw.includes("__masterChain"));
    expect(raw).not.toContain("__masterChain");
    expect(raw).not.toContain("__instanceId");
  });
});
