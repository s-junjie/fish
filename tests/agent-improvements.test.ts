import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { normalizeTextStyle } from "../src/core/dsl/normalize/text-sizing";
import { applyTextTransform } from "../src/core/export-text";
import schema from "../src/core/dsl/fish.schema.json";
import { EFFECT_TYPES } from "../src/core/dsl/schema-enums";
import { mirrorElement } from "../src/core/interactions/line-ops";
import { DesignElement, TextElement } from "../src/core/dsl/types";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { writeDemoFixture } from "./helpers/demo-fixture";

describe("agent improvements: textShadow, flip H/V, and compose stdin", () => {
  it("normalizes textShadow in TextStyle", () => {
    const style = normalizeTextStyle({
      fontFamily: "Inter",
      fontSize: 32,
      color: "#FFFFFF",
      textShadow: "0 0 10px rgba(0,255,255,0.8)"
    }, {});
    expect(style.textShadow).toBe("0 0 10px rgba(0,255,255,0.8)");

    const styleSnake = normalizeTextStyle({
      fontFamily: "Inter",
      fontSize: 32,
      color: "#FFFFFF",
      text_shadow: "0 0 20px #FF00FF"
    }, {});
    expect(styleSnake.textShadow).toBeUndefined();
  });

  it("moves a CSS textShadow into the effect stack on load", () => {
    const doc = {
      version: "0.1",
      id: "doc_shadow_test",
      name: "Shadow Test",
      canvas: { unit: "px", width: 800, height: 600, background: { type: "solid", color: "#111111" } },
      elements: [
        {
          id: "txt_1",
          type: "text",
          content: "GLOWING TEXT",
          x: 50,
          y: 50,
          width: 300,
          height: 60,
          style: {
            fontFamily: "Inter",
            fontSize: 48,
            color: "#00FFFF",
            textShadow: "0 0 20px rgba(0,255,255,0.8), 0 0 40px rgba(0,255,255,0.4)"
          }
        }
      ]
    };

    const res = normalizeDesignDocument(doc);
    const txt = getActivePage(res.document).children[0] as TextElement;
    expect(txt.style.textShadow).toBeUndefined();
    expect(txt.effects?.map((e) => e.type)).toEqual(["drop-shadow", "drop-shadow"]);
    expect(txt.effects?.map((e) => (e as { blur?: number }).blur)).toEqual([40, 20]);
  });

  it("mirrorElement toggles flipX and flipY on non-line elements", () => {
    const rect: DesignElement = {
      id: "r1",
      type: "rect",
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      rotation: 0
    };

    // Horizontal mirror across center toggles flipX
    const h0 = mirrorElement(rect, "h", 150);
    expect(h0.flipX).toBe(true);
    expect(h0.flipY).toBeUndefined();

    // Vertical mirror across center toggles flipY
    const v0 = mirrorElement(rect, "v", 150);
    expect(v0.flipY).toBe(true);
    expect(v0.flipX).toBeUndefined();

    // Repeated toggle flips back
    const h1 = mirrorElement(h0, "h", 150);
    expect(h1.flipX).toBe(false);
  });

  it("fish compose accepts stdin with - argument", () => {
    const root = path.resolve(__dirname, "..");
    const fishCli = path.join(root, "dist/fish-agent-kit/tools/fish.cjs");
    const templatePath = path.join(root, "dist/fish-agent-kit/templates/blank.fish.html");
    const tmpOut = path.join(root, "dist/fish-agent-kit/test-stdin-out.fish.html");

    // Only test if dist/fish-agent-kit is built
    if (!fs.existsSync(fishCli) || !fs.existsSync(templatePath)) return;

    try {
      const designJson = JSON.stringify({
        version: "0.1",
        canvas: { unit: "px", width: 400, height: 300 },
        elements: [
          {
            id: "t1",
            type: "text",
            content: "From Stdin",
            x: 10,
            y: 10,
            width: 100,
            height: 30,
            style: { fontSize: 16, color: "#fff", textShadow: "0 0 8px #f0f" }
          }
        ]
      });

      execSync(`node "${fishCli}" compose - "${templatePath}" --out "${tmpOut}"`, {
        input: designJson,
        encoding: "utf8"
      });

      expect(fs.existsSync(tmpOut)).toBe(true);
      const outContent = fs.readFileSync(tmpOut, "utf8");
      expect(outContent).toContain("From Stdin");
      // The shadow survives as the one spelling the model has: an effect. The
      // CSS `textShadow` string is an input alias and is folded on load.
      expect(outContent).toContain("drop-shadow");
      expect(outContent).not.toContain("textShadow");
    } finally {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    }
  });

  it("fish compose automatically embeds local files declared in assets manifest", () => {
    const root = path.resolve(__dirname, "..");
    const fishCli = path.join(root, "dist/fish-agent-kit/tools/fish.cjs");
    const templatePath = path.join(root, "dist/fish-agent-kit/templates/blank.fish.html");

    if (!fs.existsSync(fishCli) || !fs.existsSync(templatePath)) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-compose-local-assets-"));
    const tmpOut = path.join(tmpDir, "out.fish.html");
    const svgFile = path.join(tmpDir, "icon.svg");
    const jsonFile = path.join(tmpDir, "design.json");

    try {
      fs.writeFileSync(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#f00"/></svg>', "utf8");
      fs.writeFileSync(
        jsonFile,
        JSON.stringify({
          version: "0.1",
          canvas: { unit: "px", width: 400, height: 300 },
          assets: [
            { id: "local_icon", file: "./icon.svg", name: "Local Icon" }
          ],
          elements: [
            { id: "box", type: "rect", x: 0, y: 0, width: 32, height: 32, fills: [{ type: "image", assetId: "local_icon" }] }
          ]
        }),
        "utf8"
      );

      execSync(`node "${fishCli}" compose "${jsonFile}" "${templatePath}" --out "${tmpOut}"`, {
        encoding: "utf8"
      });

      expect(fs.existsSync(tmpOut)).toBe(true);
      const outContent = fs.readFileSync(tmpOut, "utf8");
      expect(outContent).toContain("data:image/svg+xml;base64,");
      expect(outContent).toContain('"local_icon"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("computeFilterRegion expands filter region dynamically when blur is large", async () => {
    const { computeFilterRegion } = await import("../src/ui/canvas/CanvasDefs");

    // In the element's own units, because a spread's silhouette is an feImage
    // built to BE this rectangle — see `computeFilterRegion`. A small blur still
    // gets one whole box length of padding on every side.
    const normalRegion = computeFilterRegion(200, 100, [
      { type: "drop-shadow", color: "#000", offset: { x: 0, y: 4 }, blur: 4, enabled: true }
    ]);
    expect(normalRegion.x).toBe(-200);
    expect(normalRegion.y).toBe(-100);
    expect(normalRegion.width).toBe(600);
    expect(normalRegion.height).toBe(300);

    // Large blur (blur = 100) expands padding well beyond that to prevent sharp clipping
    const largeBlurRegion = computeFilterRegion(200, 100, [
      { type: "drop-shadow", color: "#000", offset: { x: 0, y: 20 }, blur: 100, enabled: true }
    ]);
    // 3 * blur = 300px radius, less the 20px offset on the top side.
    expect(largeBlurRegion.x).toBe(-300);
    expect(largeBlurRegion.y).toBe(-280);
    expect(largeBlurRegion.width).toBe(800);
    expect(largeBlurRegion.height).toBe(700);
  });
});


/**
 * `textTransform` was registered in the property registry and taught in
 * dsl.md long before anything read it: the value round-tripped, saved, and
 * painted as typed. The manifest told every external author "Case transform
 * applied at render time", which was the one claim they had no way to check.
 */
describe("textTransform reaches the glyphs", () => {
  const DOC_VERSION = "0.1";

  it("applies each keyword the way CSS does", () => {
    expect(applyTextTransform("hello world", "uppercase")).toBe("HELLO WORLD");
    expect(applyTextTransform("HELLO World", "lowercase")).toBe("hello world");
    // Capitalize is per WORD in CSS, not first-letter of the string.
    expect(applyTextTransform("hello wide world", "capitalize")).toBe("Hello Wide World");
    expect(applyTextTransform("Hello", "capitalize")).toBe("Hello");
    expect(applyTextTransform("hello", undefined)).toBe("hello");
    expect(applyTextTransform("hello", "none")).toBe("hello");
  });

  it("leaves text outside ASCII alone, and never splits a surrogate pair", () => {
    // `toUpperCase` is locale-independent and correct for the Turkish dotless i;
    // what matters here is that a non-Latin string is not mangled by a regex
    // written for word characters.
    expect(applyTextTransform("café Straße", "uppercase")).toBe("CAFÉ STRASSE");
    expect(applyTextTransform("日本語 text", "lowercase")).toBe("日本語 text");
    expect(applyTextTransform("A😀B", "uppercase")).toBe("A😀B");
  });

  it("survives a load, so the field is not dropped on the way back in", () => {
    const { document } = normalizeDesignDocument({
      version: DOC_VERSION,
      canvas: { width: 200, height: 100 },
      elements: [
        {
          id: "t",
          type: "text",
          content: "shout",
          style: { fontFamily: "Inter", fontSize: 12, color: "#fff", textTransform: "uppercase" }
        }
      ]
    } as never);
    const el = getActivePage(document).children?.[0] as { style?: { textTransform?: string } };
    expect(el?.style?.textTransform).toBe("uppercase");
  });

  it("is on a text style as well as on a text element", () => {
    // A style bound by `textStyleId` carries the whole `TextStyle`, so the field
    // has to survive the style path too or the inspector would show it greyed.
    const style = normalizeTextStyle(
      { fontFamily: "Inter", fontSize: 12, color: "#fff", textTransform: "capitalize" },
      {}
    );
    expect(style.textTransform).toBe("capitalize");
  });

  // The vocabulary an external author reads is the schema, so it has to be the
  // one the engine applies — not a second list free to drift from it.
  it("is published with the vocabulary the engine accepts", () => {
    expect(schema.definitions.TextStyle.properties.textTransform.enum).toEqual([
      "none",
      "uppercase",
      "lowercase",
      "capitalize"
    ]);
  });
});

/**
 * `text-shadow` was a second effect type for the same paint: a drop shadow on a
 * text element already renders through the glyphs (a CSS `text-shadow`), so the
 * type said nothing the renderer did not decide for itself. It is now an ALIAS —
 * accepted on the way in, folded onto `drop-shadow` and reported, so a document
 * that asked for a text shadow can read what happened to it.
 */
describe("text-shadow is an alias for drop-shadow", () => {
  const doc = (effects: unknown[]) =>
    normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 200, height: 100 },
      elements: [
        {
          id: "t",
          type: "text",
          content: "lifted",
          style: { fontFamily: "Inter", fontSize: 14, color: "#fff" },
          effects
        }
      ]
    } as never);

  it("folds a text shadow into a drop shadow", () => {
    const { document } = doc([{ type: "text-shadow", color: "#0008", offset: { x: 0, y: 4 }, blur: 8 }]);
    const el = getActivePage(document).children?.[0] as { effects?: Array<{ type: string; blur: number }> };
    expect(el?.effects?.[0]?.type).toBe("drop-shadow");
    expect(el?.effects?.[0]?.blur).toBe(8);
  });

  it("leaves one spelling when a document carries both", () => {
    const { document } = doc([
      { type: "text-shadow", color: "#0008", offset: { x: 0, y: 4 }, blur: 8 },
      { type: "drop-shadow", color: "#000c", offset: { x: 2, y: 2 }, blur: 2 }
    ]);
    const el = getActivePage(document).children?.[0] as { effects?: Array<{ type: string }> };
    expect(el?.effects?.map((e) => e.type)).toEqual(["drop-shadow", "drop-shadow"]);
  });

  it("reports the fold, so the rewrite is not silent", () => {
    const { repairs } = doc([{ type: "text-shadow", color: "#0008", offset: { x: 0, y: 4 }, blur: 8 }]);
    const folds = repairs.filter((r) => /text-shadow/i.test(r.message));
    expect(folds).toHaveLength(1);
    expect(folds[0].message).toContain("drop-shadow");
  });

  it("drops a spread the alias cannot paint", () => {
    const { document } = doc([
      { type: "text-shadow", color: "#0008", offset: { x: 0, y: 4 }, blur: 8, spread: 6 }
    ]);
    const el = getActivePage(document).children?.[0] as { effects?: Array<{ spread?: number }> };
    expect(el?.effects?.[0]?.spread).toBeUndefined();
  });

  it("round-trips the author's own offset spellings, as a drop shadow does", () => {
    const { document } = doc([{ type: "text-shadow", color: "#0008", offsetX: 3, offsetY: 5, blur: 1 }]);
    const el = getActivePage(document).children?.[0] as { effects?: Array<{ offset?: { x: number; y: number } }> };
    expect(el?.effects?.[0]?.offset).toEqual({ x: 3, y: 5 });
  });

  it("is no longer published as its own type", () => {
    const enumValues = schema.definitions.Effect.properties.type.enum;
    expect(enumValues).not.toContain("text-shadow");
    expect(EFFECT_TYPES).not.toContain("text-shadow");
  });

  it("moves a CSS textShadow string into the effect stack", () => {
    const { document } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 200, height: 100 },
      elements: [
        {
          id: "t",
          type: "text",
          content: "glow",
          style: { fontFamily: "Inter", fontSize: 14, color: "#fff", textShadow: "0 0 20px #00ffff" }
        }
      ]
    } as never);
    const el = getActivePage(document).children?.[0] as TextElement;
    expect(el.style.textShadow).toBeUndefined();
    expect(el.effects?.[0]?.type).toBe("drop-shadow");
    expect((el.effects?.[0] as { blur?: number })?.blur).toBe(20);
  });

  it("fish compact and fish assets CLI commands inspect and compact documents", () => {
    const root = path.resolve(__dirname, "..");
    const fishCli = path.join(root, "dist/fish-agent-kit/tools/fish.cjs");
    const shell = path.join(root, "dist/index.html");
    if (!fs.existsSync(fishCli) || !fs.existsSync(shell)) return;
    const demoPath = writeDemoFixture(fs.readFileSync(shell, "utf-8"));

    const compactOut = execSync(`"${process.execPath}" "${fishCli}" compact "${demoPath}"`, {
      encoding: "utf8"
    });
    const parsedCompact = JSON.parse(compactOut);
    expect(parsedCompact.version).toBe("0.1");
    expect((parsedCompact as Record<string, unknown>).elements).toBeUndefined();
    expect(Array.isArray(parsedCompact.pages)).toBe(true);

    const assetsOut = execSync(`"${process.execPath}" "${fishCli}" assets "${demoPath}" --json`, {
      encoding: "utf8"
    });
    const parsedAssets = JSON.parse(assetsOut);
    expect(parsedAssets.count).toBeGreaterThanOrEqual(1);
    expect(parsedAssets.assets[0]).toHaveProperty("id");
  });
});

/**
 * Effect type spellings are canonical: the CSS-derived `backdrop-blur` is read
 * verbatim, and the pre-release `background-blur` spelling is not.
 */
describe("effect type spellings", () => {
  const doc = (type: string) =>
    normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 200, height: 100 },
      elements: [
        { id: "b", type: "rect", width: 10, height: 10, effects: [{ type, blur: 12, enabled: true }] }
      ]
    } as never);

  it("drops the pre-rename background-blur spellings", () => {
    for (const legacy of ["background-blur", "backgroundBlur"]) {
      const el = getActivePage(doc(legacy).document).children?.[0] as { effects?: Array<{ type: string }> };
      expect(el?.effects, `${legacy} was still absorbed`).toBeUndefined();
    }
  });

  it("accepts the canonical spelling verbatim", () => {
    const el = getActivePage(doc("backdrop-blur").document).children?.[0] as { effects?: Array<{ type: string }> };
    expect(el?.effects?.[0]?.type).toBe("backdrop-blur");
  });
});
