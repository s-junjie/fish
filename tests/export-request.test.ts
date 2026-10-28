import { describe, it, expect } from "vitest";
import { auditToleranceOf, parseReportRequest, screenshotPlan } from "../src/core/export-request";

/**
 * The headless reporting channel. Everything here is reached by a URL a browser's
 * command line can open, so a parse that is too strict silently disables the whole
 * feature and a plan that is subtly wrong produces a crop of the wrong rectangle —
 * which still looks like a correct answer.
 */

describe("parseReportRequest", () => {
  it("ignores an ordinary document", () => {
    expect(parseReportRequest("")).toBeNull();
    expect(parseReportRequest("?view=canvas")).toBeNull();
    expect(parseReportRequest("?report=0")).toBeNull();
  });

  it("reports the document for a bare request", () => {
    expect(parseReportRequest("?report=1")).toEqual({ scale: 1 });
  });

  it("carries the element id and the scale", () => {
    expect(parseReportRequest("?report=1&element=hero&scale=2")).toEqual({
      elementId: "hero",
      scale: 2
    });
  });

  // An unbounded scale is a mistake that would ask the browser for a window of
  // billions of pixels, which fails as an out-of-memory rather than as a message.
  it("clamps a nonsense scale instead of passing it through", () => {
    const scaleOf = (q: string) => parseReportRequest(q)?.scale;
    expect(scaleOf("?report=1&scale=0")).toBe(1);
    expect(scaleOf("?report=1&scale=-3")).toBe(1);
    expect(scaleOf("?report=1&scale=abc")).toBe(1);
    expect(scaleOf("?report=1&scale=1000")).toBe(8);
  });

  it("accepts an origin with or without the report flag", () => {
    expect(parseReportRequest("?view=canvas&origin=116,484")?.origin).toEqual({ x: 116, y: 484 });
    expect(parseReportRequest("?view=canvas&origin=-10.5, 20")?.origin).toEqual({ x: -10.5, y: 20 });
  });

  it("ignores an origin it cannot read rather than defaulting to a wrong one", () => {
    expect(parseReportRequest("?origin=nope")?.origin).toBeUndefined();
    expect(parseReportRequest("?origin=1,2,3")?.origin).toBeUndefined();
  });

  it("carries no export payload of its own — the raster is the browser's job", () => {
    // `?export=svg` used to ask the page to serialize its own vector. Removed: the
    // channel now reports geometry only, and the picture comes from Chrome's
    // `--screenshot`. A stray parameter must not look like a request.
    expect(parseReportRequest("?export=svg")).toBeNull();
    expect(parseReportRequest("?export=png")).toBeNull();
    expect(parseReportRequest("?report=1&export=svg&scale=2&element=card")).toEqual({
      scale: 2,
      elementId: "card"
    });
  });
});

describe("the audit tolerance the caller asks for", () => {
  it("is carried when it is a distance, and dropped when it is not", () => {
    expect(parseReportRequest("?report=1&audit=1&auditTolerance=2")?.auditTolerance).toBe(2);
    expect(parseReportRequest("?report=1&audit=1")?.auditTolerance).toBeUndefined();
    expect(parseReportRequest("?report=1&audit=1&auditTolerance=wide")?.auditTolerance).toBeUndefined();
  });

  it("stays a tolerance: 0 is not a distance and 500 grades nothing", () => {
    // A caller that asks for a coarser grade gets one, not a rule that has been
    // quietly switched off — and a distance that is not positive is no answer,
    // so the default speaks rather than a number nobody meant.
    expect(auditToleranceOf("0")).toBeUndefined();
    expect(auditToleranceOf("-4")).toBeUndefined();
    expect(auditToleranceOf("500")).toBe(16);
    expect(auditToleranceOf("")).toBeUndefined();
    expect(auditToleranceOf(null)).toBeUndefined();
  });
});

describe("screenshotPlan", () => {
  it("keeps the window in CSS pixels and puts the scale in the bitmap", () => {
    // Scaling both is the bug this pair exists to catch: the element lands in a
    // quarter of a frame twice its size, which is a plausible-looking image.
    expect(screenshotPlan(360, 112.59, 2)).toEqual({ window: "360x113", expected: "720x226" });
    expect(screenshotPlan(360, 112.59, 1)).toEqual({ window: "360x113", expected: "360x113" });
  });

  it("derives the bitmap from the rounded window, not from the original box", () => {
    // 112.59 rounds to a 113px window; promising 225 for a 226px file reports a
    // mismatch on every fractional dimension and teaches the reader to ignore it.
    const { window, expected } = screenshotPlan(360, 112.59, 2);
    const [w, h] = window.split("x").map(Number);
    const [ew, eh] = expected.split("x").map(Number);
    expect(ew).toBe(w * 2);
    expect(eh).toBe(h * 2);
  });

  it("never asks for a zero-pixel window", () => {
    expect(screenshotPlan(0, 0, 1).window).toBe("1x1");
    expect(screenshotPlan(-5, 10, 1).window).toBe("1x10");
  });
});
