import { describe, expect, it } from "vitest";
import type { DesignElement, FrameElement, InstanceElement } from "../src/core/dsl/types";
import { childScrollOffset, computeContainerScrollBounds } from "../src/core/geometry/scroll-bounds";
import { withOverflow } from "../src/ui/inspector/ScrollOverflowControl";
import { clipsContent, overflowAxes, type OverflowFields } from "../src/core/dsl/overflow";

const fields = (el: DesignElement): OverflowFields => el as unknown as OverflowFields;

const offsetOf = (el: DesignElement): [number | undefined, number | undefined] =>
  el.type === "frame" || el.type === "component" || el.type === "instance"
    ? [el.scrollX, el.scrollY]
    : [undefined, undefined];

const scrolled = (): DesignElement =>
  ({
    id: "f",
    type: "frame",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    overflowX: "hidden",
    overflowY: "auto",
    scrollX: 0,
    scrollY: 60,
    children: []
  }) as unknown as DesignElement;

describe("picking a value writes the axes as one statement", () => {
  it("clears the longhands a shorthand replaces", () => {
    const next = withOverflow(scrolled(), "hidden");
    expect(next.type === "frame" && next.overflow).toBe("hidden");
    expect(next.type === "frame" && next.overflowX).toBeUndefined();
    expect(next.type === "frame" && next.overflowY).toBeUndefined();
  });

  it("ends the position when nothing can scroll any more", () => {
    const next = withOverflow(scrolled(), "hidden");
    expect(clipsContent(fields(next))).toBe(true);
    expect(offsetOf(next), "a pan nothing paints").toEqual([undefined, undefined]);
  });

  it("keeps the position when the box still scrolls", () => {
    const crossed = withOverflow(scrolled(), "auto");
    expect(offsetOf(crossed)).toEqual([0, 60]);
  });

  it("leaves nothing behind when the box stops clipping", () => {
    const next = withOverflow(scrolled(), "visible");
    expect(clipsContent(fields(next))).toBe(false);
    expect(offsetOf(next)).toEqual([undefined, undefined]);
  });

  it("collapses a mixed pair to the value the user picked", () => {
    const mixed = { ...scrolled(), overflowX: "auto", overflowY: "hidden" } as DesignElement;
    const next = withOverflow(mixed, "auto");
    expect(overflowAxes(fields(next))).toEqual({ x: "auto", y: "auto" });
    expect(next.type === "frame" && next.overflowX).toBeUndefined();
  });
});

describe("a container that does not clip does not offset its children", () => {
  const child = { id: "c", type: "rect", x: 0, y: 0, width: 10, height: 10 } as DesignElement;
  const frame = (extra: Partial<FrameElement> = {}): FrameElement => ({
    id: "f",
    type: "frame",
    x: 10,
    y: 20,
    width: 100,
    height: 100,
    overflowX: "hidden",
    overflowY: "auto",
    scrollY: 60,
    children: [child],
    ...extra
  });

  it("leaves the offset at zero once nothing clips", () => {
    expect(childScrollOffset(child, frame({ overflow: "visible", overflowX: undefined, overflowY: undefined }), 0, 60)).toEqual({
      offsetX: 0,
      offsetY: 0
    });
  });

  it("still moves it while the axis cannot scroll, because clipping is what paints", () => {
    // The axis gates the WHEEL (`clampScrollOffset`); the renderer's own test for
    // an offset is clipping alone. An offset left on a clipping container is
    // painted, so the readers have to place it.
    expect(childScrollOffset(child, frame({ overflow: "hidden", overflowX: undefined, overflowY: undefined }), 0, 60)).toEqual({
      offsetX: -0,
      offsetY: -60
    });
  });

  it("still moves the child of a clipping container", () => {
    expect(childScrollOffset(child, frame(), 0, 60)).toEqual({ offsetX: -0, offsetY: -60 });
  });

  it("and offers nothing to scroll to", () => {
    const tall = { id: "tall", type: "rect", x: 0, y: 0, width: 100, height: 300 } as DesignElement;
    const base: FrameElement = { ...frame(), children: [tall] };
    expect(computeContainerScrollBounds(base).maxScrollY, "a clipping container scrolls").toBe(200);
    expect(
      computeContainerScrollBounds({ ...base, overflow: "visible", overflowX: undefined, overflowY: undefined }).maxScrollY
    ).toBe(0);
  });

  it("reads the axes off the master when the container is an instance", () => {
    const master = {
      id: "m",
      type: "component",
      overflowX: "hidden",
      overflowY: "auto",
      children: [child]
    } as unknown as DesignElement;
    const instance = {
      id: "i",
      type: "instance",
      componentId: "m",
      x: 0,
      y: 0,
      width: 100,
      height: 100
    } as InstanceElement;
    expect(childScrollOffset(child, instance, 0, 60, master)).toEqual({ offsetX: -0, offsetY: -60 });

    const unclipped = { ...master, overflow: "visible", overflowX: undefined, overflowY: undefined } as DesignElement;
    expect(childScrollOffset(child, instance, 0, 60, unclipped)).toEqual({ offsetX: 0, offsetY: 0 });
  });
});
