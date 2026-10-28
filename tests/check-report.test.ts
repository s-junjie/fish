import { describe, expect, it } from "vitest";
import { runCheck, withFindings } from "../src/core/check-report";
import { flattenLayout } from "../src/core/dsl/layout-flat";

const authored = (elements: unknown[]) => ({
  version: "0.1",
  canvas: { width: 900, height: 700 },
  elements
});

const rect = (id: string, x: number, y: number, width: number, height: number) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width,
  height
});

describe("runCheck", () => {
  it("passes a clean live document without normalizing it again", () => {
    const result = runCheck(authored([rect("a", 0, 0, 40, 40)]));
    expect(result.repairs).toEqual([]);
    expect(result.report.ok).toBe(true);
    expect(result.report.findings).toEqual([]);
    expect(result.report.geometry).toEqual([]);
  });

  it("turns a lossy repair into a warning finding and a failed verdict", () => {
    const result = runCheck(
      authored([{ ...rect("a", 0, 0, 40, 40), nonsenseKey: "center" }]),
      { candidate: true }
    );
    const repair = result.report.findings.find((f) => f.code === "dropped-property");
    expect(repair?.level).toBe("warning");
    expect(repair?.path).toContain("nonsenseKey");
    expect(result.report.lossyRepairs).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.failReason).toContain("repairs");
  });

  it("fails a warning only when strict asks for it", () => {
    const input = authored([
      {
        ...rect("a", 0, 0, 40, 40),
        fills: [{ type: "solid", color: "#ffffff", tokenId: "tok_missing" }]
      }
    ]);
    const relaxed = runCheck(input, { candidate: true });
    const strict = runCheck(input, { candidate: true, strict: true });
    expect(relaxed.report.counts.warning).toBeGreaterThan(0);
    expect(relaxed.report.ok).toBe(true);
    expect(strict.report.ok).toBe(false);
    expect(strict.report.failReason).toContain("strict");
  });

  it("fails a broken component reference without --strict", () => {
    const result = runCheck(
      authored([
        { id: "master", type: "frame", name: "Master", x: 0, y: 0, width: 80, height: 40 },
        { id: "inst", type: "instance", name: "Inst", componentId: "master", x: 200, y: 0, width: 80, height: 40 }
      ]),
      { candidate: true }
    );
    const finding = result.report.findings.find((f) => f.elementId === "inst");
    expect(finding?.level).toBe("error");
    expect(result.report.ok).toBe(false);
  });

  it("reports auto-layout overflow as a geometry finding", () => {
    const result = runCheck(
      authored([
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 0,
          y: 0,
          width: 360,
          height: 100,
          ...flattenLayout({ mode: "flex", direction: "column", gap: 0, padding: 0 }),
          children: [rect("a", 0, 0, 40, 120), rect("b", 0, 120, 40, 120)]
        }
      ]),
      { candidate: true }
    );
    const overflow = result.report.findings.find((f) => f.code === "layout-overflow");
    expect(overflow?.level).toBe("warning");
    expect(overflow?.elementId).toBe("card");
  });

  it("can skip the layout report without skipping validation", () => {
    const input = authored([
      {
        ...rect("a", 0, 0, 40, 40),
        fills: [{ type: "solid", color: "#ffffff", tokenId: "tok_missing" }]
      }
    ]);
    const result = runCheck(input, { candidate: true, geometry: false });
    expect(result.report.geometry).toBeUndefined();
    expect(result.report.counts.warning).toBeGreaterThan(0);
  });
});

describe("withFindings", () => {
  it("appends browser findings and recomputes the verdict", () => {
    const base = runCheck(authored([rect("a", 0, 0, 40, 40)])).report;
    const report = withFindings(
      base,
      [{ source: "ink", level: "error", message: "text is clipped", elementId: "a", code: "clip" }],
      false
    );
    expect(report.ok).toBe(false);
    expect(report.counts.error).toBe(1);
    expect(report.findings).toHaveLength(1);
  });
});
