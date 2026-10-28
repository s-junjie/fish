import { describe, expect, it } from "vitest";
import { CanvasDefs } from "../src/ui/canvas/CanvasDefs";
import { getShapeLocalPath } from "../src/core/geometry/gradient-utils";
import { defById } from "./support/defs";
import {
  type ComponentElement,
  type FrameElement,
  type InstanceElement,
  hasCornerSmoothing,
  OVERRIDABLE_PROPERTIES
} from "../src/core/dsl/types";
import { resolveInstanceContent } from "../src/core/interactions/instance-resolve";

describe("frame and instance clipPath with corner smoothing", () => {
  it("emits smoothed clipPath matching getShapeLocalPath for a frame with cornerSmoothing", () => {
    const frame: FrameElement = {
      id: "frame1",
      type: "frame",
      name: "Frame",
      x: 0,
      y: 0,
      width: 359,
      height: 470,
      borderRadius: 67,
      cornerSmoothing: 0.95,
      clipContent: true,
      children: []
    };

    const defs = CanvasDefs({ allElements: [frame], selectedIds: new Set() }) as any;
    const clipPath = defById(defs, "clip_frame1");

    expect(clipPath).toBeTruthy();
    const pathD = clipPath.props.children.props.d;
    expect(pathD).toMatch(/C/);
    expect(pathD).toBe(getShapeLocalPath(frame));
  });

  it("emits standard arc clipPath for a frame without cornerSmoothing", () => {
    const frame: FrameElement = {
      id: "frame2",
      type: "frame",
      name: "Frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      borderRadius: 20,
      clipContent: true,
      children: []
    };

    const defs = CanvasDefs({ allElements: [frame], selectedIds: new Set() }) as any;
    const clipPath = defById(defs, "clip_frame2");

    expect(clipPath).toBeTruthy();
    const pathD = clipPath.props.children.props.d;
    expect(pathD).toContain("A 20 20");
    expect(pathD).not.toMatch(/C/);
    expect(pathD).toBe(getShapeLocalPath(frame));
  });

  it("inherits cornerSmoothing from master for instance clipPath", () => {
    const master: ComponentElement = {
      id: "comp1",
      type: "component",
      name: "Card",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      borderRadius: 40,
      cornerSmoothing: 0.6,
      clipContent: true,
      children: []
    };

    const instance: InstanceElement = {
      id: "inst1",
      type: "instance",
      name: "Card Instance",
      componentId: "comp1",
      x: 400,
      y: 0,
      width: 300,
      height: 200
    };

    const defs = CanvasDefs({ allElements: [master, instance], selectedIds: new Set() }) as any;
    const clipPath = defById(defs, "clip_inst1");

    expect(clipPath).toBeTruthy();
    const pathD = clipPath.props.children.props.d;
    expect(pathD).toMatch(/C/);
  });

  it("honours instance override of cornerSmoothing", () => {
    const master: ComponentElement = {
      id: "comp2",
      type: "component",
      name: "Card",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      borderRadius: 40,
      cornerSmoothing: 0.6,
      clipContent: true,
      children: []
    };

    const instance: InstanceElement = {
      id: "inst2",
      type: "instance",
      name: "Card Instance",
      componentId: "comp2",
      x: 400,
      y: 0,
      width: 300,
      height: 200,
      cornerSmoothing: 0
    };

    const defs = CanvasDefs({ allElements: [master, instance], selectedIds: new Set() }) as any;
    const clipPath = defById(defs, "clip_inst2");

    expect(clipPath).toBeTruthy();
    const pathD = clipPath.props.children.props.d;
    expect(pathD).toContain("A 40 40");
    expect(pathD).not.toMatch(/C/);
  });

  it("emits smoothed clipPath for a component with cornerSmoothing", () => {
    const comp: ComponentElement = {
      id: "comp3",
      type: "component",
      name: "Card Component",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      borderRadius: 40,
      cornerSmoothing: 0.6,
      clipContent: true,
      children: []
    };

    const defs = CanvasDefs({ allElements: [comp], selectedIds: new Set() }) as any;
    const clipPath = defById(defs, "clip_comp3");

    expect(clipPath).toBeTruthy();
    const pathD = clipPath.props.children.props.d;
    expect(pathD).toMatch(/C/);
    expect(pathD).toBe(getShapeLocalPath(comp));
  });

  it("identifies component and instance in hasCornerSmoothing and allows cornerSmoothing override", () => {
    expect(hasCornerSmoothing({ type: "component" } as any)).toBe(true);
    expect(hasCornerSmoothing({ type: "instance" } as any)).toBe(true);
    expect(OVERRIDABLE_PROPERTIES.includes("cornerSmoothing")).toBe(true);

    const master: ComponentElement = {
      id: "master_box",
      type: "component",
      name: "Master Box",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [
        {
          id: "child_rect",
          type: "rect",
          name: "Child",
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          borderRadius: 20,
          cornerSmoothing: 0
        } as any
      ]
    };

    const instance: InstanceElement = {
      id: "inst_box",
      type: "instance",
      name: "Instance Box",
      componentId: "master_box",
      x: 300,
      y: 0,
      width: 200,
      height: 200,
      overrides: [
        {
          targetId: "child_rect",
          property: "cornerSmoothing",
          value: 0.6
        }
      ]
    };

    const resolved = resolveInstanceContent(instance, master);
    const child = resolved.children[0] as any;
    expect(child).toBeTruthy();
    expect(child.cornerSmoothing).toBe(0.6);
  });
});
