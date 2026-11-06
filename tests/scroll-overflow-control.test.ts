import { describe, expect, it } from "vitest";
import type { DesignElement, FrameElement, InstanceElement } from "../src/core/dsl/types";
import { childScrollOffset, computeContainerScrollBounds } from "../src/core/geometry/scroll-bounds";
import { withClipContent, withScrollOverflow } from "../src/ui/inspector/ScrollOverflowControl";

type ScrollFields = { clipContent?: boolean; scrollOverflow?: string; scrollX?: number; scrollY?: number };
const fields = (el: DesignElement): ScrollFields => el as unknown as ScrollFields;
const offsetOf = (el: DesignElement): [number | undefined, number | undefined] => [
  fields(el).scrollX,
  fields(el).scrollY
];

const scrolled = (): DesignElement =>
  ({
    id: "f",
    type: "frame",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    clipContent: true,
    scrollOverflow: "vertical",
    scrollX: 0,
    scrollY: 60,
    children: []
  }) as unknown as DesignElement;

describe("ending the scroll ends the position with it", () => {
  it("clears the offset when clipping is switched off", () => {
    const next = withClipContent(scrolled(), false);
    expect(fields(next).clipContent).toBe(false);
    expect(fields(next).scrollOverflow).toBe("none");
    expect(offsetOf(next), "a pan nothing paints").toEqual([undefined, undefined]);
  });

  it("leaves the offset alone when clipping is switched on", () => {
    const parked = { ...scrolled(), clipContent: false, scrollX: 4, scrollY: 8 } as DesignElement;
    const next = withClipContent(parked, true);
    expect(fields(next).clipContent).toBe(true);
    expect(offsetOf(next)).toEqual([4, 8]);
  });

  it("clears the offset when the mode goes back to none", () => {
    const next = withScrollOverflow(scrolled(), "none");
    expect(fields(next).scrollOverflow).toBe("none");
    expect(offsetOf(next)).toEqual([undefined, undefined]);
    expect(fields(next).clipContent, "clipping is its own statement").toBe(true);
  });

  it("clips when a scrolling mode is picked", () => {
    const open = { ...scrolled(), clipContent: false, scrollOverflow: "none" } as DesignElement;
    const next = withScrollOverflow(open, "horizontal");
    expect(fields(next).scrollOverflow).toBe("horizontal");
    expect(fields(next).clipContent).toBe(true);
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
    clipContent: true,
    scrollOverflow: "vertical",
    scrollY: 60,
    children: [child],
    ...extra
  });

  it("leaves the offset at zero once clipping is off", () => {
    expect(childScrollOffset(child, frame({ clipContent: false }), 0, 60)).toEqual({ offsetX: 0, offsetY: 0 });
  });

  it("still moves it while the mode says none, because that is what paints", () => {
    // The mode gates the WHEEL (`clampScrollOffset`); the renderer's own test for
    // an offset is clipping alone. An offset left on a clipping container is
    // painted, so the readers have to place it.
    expect(childScrollOffset(child, frame({ scrollOverflow: "none" }), 0, 60)).toEqual({
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
    expect(computeContainerScrollBounds({ ...base, clipContent: false }).maxScrollY).toBe(0);
  });

  it("reads clipping off the master when the container is an instance", () => {
    const master = {
      id: "m",
      type: "component",
      clipContent: true,
      scrollOverflow: "vertical",
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

    const unclipped = { ...master, clipContent: false } as DesignElement;
    expect(childScrollOffset(child, instance, 0, 60, unclipped)).toEqual({ offsetX: 0, offsetY: 0 });
  });
});
