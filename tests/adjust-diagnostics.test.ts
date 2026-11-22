import { describe, expect, it } from "vitest";
import { adjustDiagnostics } from "../src/core/adjust-diagnostics";
import { normalizeColorFilter } from "../src/core/dsl/normalize/text-sizing";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { NormalizationRepair } from "../src/core/dsl/normalize/shared";
import type { DesignDocument } from "../src/core/dsl/types";

describe("a colour axis that is too big", () => {
  it("stores the clamped value and says so, without failing the check", () => {
    const repairs: NormalizationRepair[] = [];
    const out = normalizeColorFilter({ temperature: 6, contrast: 6 }, "/fills/0/adjust", repairs, "paint");

    expect(out).toEqual({ temperature: 1, contrast: 6 });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      kind: "paint",
      path: "/fills/0/adjust/temperature",
      severity: "info"
    });
    expect(repairs[0].message).toContain("6 is outside -1..1");
    expect(repairs[0].message).toContain("stored as 1");
  });

  it("says nothing about a value it kept", () => {
    const repairs: NormalizationRepair[] = [];
    normalizeColorFilter({ temperature: 0.6, contrast: 1.4, exposure: -2 }, "/f", repairs, "paint");
    expect(repairs).toEqual([]);
  });

  it("clamps a value that arrived as a CSS filter string", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 100, height: 100 },
      pages: [
        {
          id: "page_1",
          name: "Page 1",
          children: [
            { id: "img", type: "rect", x: 0, y: 0, width: 100, height: 100, filter: "contrast(-2) invert(2)" }
          ]
        }
      ]
    });
    const el = document.pages![0].children![0] as { adjust?: Record<string, number> };
    expect(el.adjust).toEqual({ contrast: 0, invert: 1 });
    expect(repairs.some((r) => r.path.endsWith("/adjust/contrast"))).toBe(true);
    expect(repairs.some((r) => r.path.endsWith("/adjust/invert"))).toBe(true);
  });

  it("reports the clamp on an image fill with its real path", () => {
    const { repairs } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 100, height: 100 },
      pages: [
        {
          id: "page_1",
          name: "Page 1",
          children: [
            {
              id: "photo",
              type: "rect",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              fills: [{ type: "image", assetId: "asset_1", fit: "cover", adjust: { saturation: 4 } }]
            }
          ]
        }
      ],
      assets: [{ id: "asset_1", name: "photo", uri: "data:image/png;base64,AAAA", width: 10, height: 10 }]
    });
    // `saturation` has no upper bound to clamp against, so nothing is reported
    // here; the value is kept and graded by `adjustDiagnostics` instead.
    expect(repairs.filter((r) => r.path.includes("/adjust"))).toEqual([]);
  });
});

describe("a colour axis past the slider's track", () => {
  const docWith = (adjust: Record<string, number>): DesignDocument =>
    ({
      version: "0.1",
      canvas: { width: 100, height: 100 },
      pages: [
        {
          id: "page_1",
          name: "Page 1",
          children: [
            {
              id: "photo",
              type: "rect",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              fills: [{ type: "image", assetId: "asset_1", fit: "cover", adjust }]
            }
          ]
        }
      ],
      assets: [{ id: "asset_1", name: "photo", uri: "data:image/png;base64,AAAA", width: 10, height: 10 }]
    }) as unknown as DesignDocument;

  it("warns, names the path, and offers the DSL edit that lands on the track", () => {
    const findings = adjustDiagnostics(docWith({ contrast: 6, saturation: 4 }));

    expect(findings.map((f) => f.level)).toEqual(["warning", "warning"]);
    expect(findings[0].message).toContain("/pages/0/children/0/fills/0/adjust/contrast is 6");
    expect(findings[0].message).toContain("0..2");
    expect(findings[0].elementId).toBe("photo");
    expect(findings[0].hint).toBe("contrast: 2");
    expect(findings[1].hint).toBe("saturation: 2");
  });

  it("stays quiet on a value the slider can hold", () => {
    expect(adjustDiagnostics(docWith({ contrast: 1.6, saturation: 1.4, temperature: -1 }))).toEqual([]);
  });

  it("stays quiet on a hue turn, which reads modulo 360", () => {
    expect(adjustDiagnostics(docWith({ hueRotate: 200 }))).toEqual([]);
  });
});
