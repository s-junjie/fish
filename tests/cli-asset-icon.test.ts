import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSvgIconDocument } from "../src/plugins/_shared/assets/svg-body";
import { assetsCommand } from "../src/core/cli/fish-assets";

const SAMPLE_LUCIDE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect width="18" height="18" x="3" y="3" rx="2"/>
  <circle cx="12" cy="12" r="4"/>
  <path d="m12 8 2 2"/>
</svg>`;

describe("SVG icon flattening for CLI", () => {
  it("inherits <svg> stroke paint and scales coordinates + strokeWidth together", () => {
    const base = parseSvgIconDocument(SAMPLE_LUCIDE_SVG);
    expect(base).not.toBeNull();
    expect(base?.mode).toBe("stroke");
    expect(base?.width).toBe(24);
    expect(base?.height).toBe(24);
    expect(base?.strokeWidth).toBe(2);

    const resized = parseSvgIconDocument(SAMPLE_LUCIDE_SVG, { size: 15 });
    expect(resized).not.toBeNull();
    expect(resized?.width).toBe(15);
    expect(resized?.height).toBe(15);
    expect(resized?.strokeWidth).toBe(1.25);

    const overridden = parseSvgIconDocument(SAMPLE_LUCIDE_SVG, { size: 16, strokeWidth: 1.5 });
    expect(overridden?.strokeWidth).toBe(1.5);
  });

  it("emits flattened JSON via `assets icon`", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fish-icon-"));
    const svgPath = path.join(tmp, "sample.svg");
    fs.writeFileSync(svgPath, SAMPLE_LUCIDE_SVG, "utf8");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const code = await assetsCommand(["icon", svgPath], {
        json: true,
        size: 16
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.count).toBe(1);
      expect(parsed.results[0].element.width).toBe(16);
      expect(parsed.results[0].element.strokes[0].width).toBe(1.33);
    } finally {
      console.log = origLog;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
