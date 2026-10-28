import { describe, expect, it } from "vitest";
import { validateTokenRefs } from "../src/core/validate-tokens";
import { validateDocument } from "../src/core/validate";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { ColorToken, DesignDocument, DesignElement, NumberToken, PaintStyle } from "../src/core/dsl/types";

const TOKEN: PaintStyle = {
  id: "tok_bg",
  name: "bg/canvas",
  styleType: "paint",
  paints: [{ type: "solid", color: "#FFFFFF" }]
};

const doc = (elements: DesignElement[], extra: Partial<DesignDocument> = {}): DesignDocument =>
  ({
    version: "0.1",
    name: "Tokens",
    canvas: { width: 100, height: 100 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 100, height: 100 }, children: elements }],
    activePageId: "page_1",
    ...extra
  }) as unknown as DesignDocument;

const card = (props: Record<string, unknown> = {}): DesignElement =>
  ({
    id: "card",
    name: "Card",
    type: "rect",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fills: [{ type: "solid", color: "#FFFFFF" }],
    ...props
  }) as unknown as DesignElement;

describe("validateTokenRefs", () => {
  it("says nothing about a document with no references", () => {
    expect(validateTokenRefs(doc([card()]))).toEqual([]);
  });

  it("accepts a paint that follows a token the document holds", () => {
    const el = card({ fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_bg" }] });
    const token: ColorToken = { id: "tok_bg", name: "bg/canvas", type: "color", value: "#ffffff" };
    expect(validateTokenRefs(doc([el], { tokens: [token] }))).toEqual([]);
  });

  it("names a fill whose token is missing, with the id and the layer", () => {
    const el = card({ fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_gone" }] });
    const [gap] = validateTokenRefs(doc([el]));
    expect(gap.level).toBe("warning");
    expect(gap.elementId).toBe("card");
    expect(gap.message).toContain('"tok_gone"');
    expect(gap.message).toContain("Fill 1");
  });

  it("names a bound number token that is not on the document", () => {
    const el = card({ tokenBindings: { borderRadius: "num_gone" } });
    const [gap] = validateTokenRefs(doc([el]));
    expect(gap.message).toContain("borderRadius");
    expect(gap.message).toContain('"num_gone"');
  });

  it("names a style id that no style backs", () => {
    const el = card({ fillStyleId: "style_gone" });
    expect(validateTokenRefs(doc([el]))[0].message).toContain("fillStyleId");
  });

  it("checks a text layer's own text style and style-level bindings", () => {
    const text = {
      id: "title",
      name: "Title",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: "Hi",
      style: { fontFamily: "Inter", fontSize: 14, color: "#000000", tokenBindings: { fontSize: "num_gone" } },
      textStyleId: "style_gone"
    } as unknown as DesignElement;
    const messages = validateTokenRefs(doc([text])).map((gap) => gap.message);
    expect(messages.some((m) => m.includes("textStyleId"))).toBe(true);
    expect(messages.some((m) => m.includes("style.fontSize"))).toBe(true);
  });

  it("checks effects and strokes as well as fills", () => {
    const el = card({
      strokes: [{ color: "#000000", width: 1, tokenId: "tok_gone" }],
      effects: [{ type: "drop-shadow", color: "#000000", offset: { x: 0, y: 2 }, blur: 4, tokenId: "tok_gone" }]
    });
    const wheres = validateTokenRefs(doc([el])).map((gap) => gap.message);
    expect(wheres.some((m) => m.includes("Stroke 1"))).toBe(true);
    expect(wheres.some((m) => m.includes("Effect 1"))).toBe(true);
  });

  it("reports a dangling reference once per id, naming every place it was asked for", () => {
    const el = card({
      fills: [
        { type: "solid", color: "#FFFFFF", tokenId: "tok_gone" },
        { type: "solid", color: "#FFFFFF", tokenId: "tok_gone" }
      ],
      strokes: [{ color: "#000000", width: 1, tokenId: "tok_gone" }]
    });
    const gaps = validateTokenRefs(doc([el]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].message).toContain("Fill 1 and Fill 2 and Stroke 1");
  });

  it("finds a dangling reference inside a style, which has no element to blame", () => {
    const style: PaintStyle = {
      id: "style_card",
      name: "surface/card",
      styleType: "paint",
      paints: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_gone" }]
    };
    const [gap] = validateTokenRefs(doc([], { styles: [style] }));
    expect(gap.elementId).toBeUndefined();
    expect(gap.message).toContain("surface/card");
  });

  it("reports an activeTheme no mode declares, because every token then falls back", () => {
    const gap = validateTokenRefs(doc([], { activeTheme: "dark" })).find((d) => d.message.includes("activeTheme"));
    expect(gap?.message).toContain('"dark"');
  });

  it("accepts an activeTheme the document declares", () => {
    const themes = validateTokenRefs(doc([], { activeTheme: "dark", modes: [{ id: "dark", name: "Dark" }] }));
    expect(themes).toEqual([]);
  });

  it("reports a container's themeMode that no mode declares", () => {
    const el = card({ themeMode: "dim" });
    expect(validateTokenRefs(doc([el]))[0].message).toContain('themeMode "dim"');
  });

  it("reaches layers nested inside a container", () => {
    const inner = card({ id: "inner", fillStyleId: "style_gone" });
    const frame = {
      id: "frame",
      name: "Frame",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [inner]
    } as unknown as DesignElement;
    expect(validateTokenRefs(doc([frame]))[0].elementId).toBe("inner");
  });
});

describe("validateTokenRefs across the two tables", () => {
  const SURFACE: ColorToken = { id: "tok_surface", name: "color/surface", type: "color", value: "#ffffff" };
  const RADIUS: NumberToken = { id: "tok_radius", name: "radius/card", type: "number", value: 12 };

  it("accepts a fill that follows a colour token in doc.tokens[]", () => {
    const el = card({ fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_surface" }] });
    expect(validateTokenRefs(doc([el], { tokens: [SURFACE] }))).toEqual([]);
  });

  it("accepts a binding that follows a number token in doc.tokens[]", () => {
    const el = card({ tokenBindings: { borderRadius: "tok_radius" } });
    expect(validateTokenRefs(doc([el], { tokens: [RADIUS] }))).toEqual([]);
  });

  // A token reference that hits a style is the write side having filed the entry
  // in the wrong table — no edit of it will ever reach the layer, and a warning
  // would let it ship.
  it("makes a tokenId that names a style an error, once the document has a token table", () => {
    const el = card({ fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_bg" }] });
    const [gap] = validateTokenRefs(doc([el], { tokens: [SURFACE], styles: [TOKEN] }));
    expect(gap.level).toBe("error");
    expect(gap.message).toContain("doc.styles[]");
    expect(gap.message).toContain("doc.tokens[]");
  });

  it("makes a tokenBindings id that names a style an error", () => {
    const el = card({ tokenBindings: { borderRadius: "style_card" } });
    const style: PaintStyle = { id: "style_card", name: "surface/card", styleType: "paint", paints: [{ type: "solid", color: "#FFF" }] };
    const [gap] = validateTokenRefs(doc([el], { tokens: [SURFACE], styles: [style] }));
    expect(gap.level).toBe("error");
    expect(gap.elementId).toBe("card");
  });

  it("makes a *StyleId that names a token an error", () => {
    const el = card({ fillStyleId: "tok_surface" });
    const [gap] = validateTokenRefs(doc([el], { tokens: [SURFACE] }));
    expect(gap.level).toBe("error");
    expect(gap.message).toContain("fillStyleId");
  });

  it("makes an id declared in BOTH tables an error", () => {
    const style: PaintStyle = { id: "tok_surface", name: "surface/card", styleType: "paint", paints: [{ type: "solid", color: "#FFF" }] };
    const [gap] = validateTokenRefs(doc([], { tokens: [SURFACE], styles: [style] }));
    expect(gap.level).toBe("error");
    expect(gap.message).toContain("BOTH");
  });

  // Normalize DROPS a value that does not fit its type and records a repair
  // (plan §5 invariant 4); `check` fails on that repair. A second, differently
  // classified verdict here would be two answers for one defect.
  it("leaves a mistyped token value to normalize's repair rather than reporting it again", () => {
    const written = {
      version: "0.1",
      name: "mistyped",
      canvas: { width: 100, height: 100, background: { type: "solid", color: "#FFFFFF" } },
      tokens: [{ id: "tok_bad", name: "bad", type: "color", value: "red" }]
    };
    const { document, repairs } = normalizeDesignDocument(written);
    expect(document.tokens).toBeUndefined();
    expect(repairs.map((r) => r.path)).toEqual(["/tokens/0/value"]);
    expect(validateTokenRefs(document as DesignDocument)).toEqual([]);
  });

  it("warns about a mode no doc.modes[] declares, and accepts one it does", () => {
    const token: ColorToken = { ...SURFACE, modes: { dark: "#0a0a0a" } };
    const [gap] = validateTokenRefs(doc([], { tokens: [token] }));
    expect(gap.level).toBe("warning");
    expect(gap.message).toContain('"dark"');
    expect(validateTokenRefs(doc([], { tokens: [token], modes: [{ id: "dark", name: "Dark" }] }))).toEqual([]);
  });

  it("grades a NUMBER token against doc.numberModes[], not the colour axis", () => {
    const token: NumberToken = { ...RADIUS, modes: { compact: 8 } };
    // The colour axis declaring the same id is not the number axis declaring it.
    const [gap] = validateTokenRefs(
      doc([], { tokens: [token], modes: [{ id: "compact", name: "Compact" }] })
    );
    expect(gap.level).toBe("warning");
    expect(gap.message).toContain("doc.numberModes[]");
    expect(
      validateTokenRefs(
        doc([], { tokens: [token], numberModes: [{ id: "compact", name: "Compact" }] })
      )
    ).toEqual([]);
  });

  it("reports a container's numberMode the number axis does not declare", () => {
    const el = card({ numberMode: "tiny" });
    const [gap] = validateTokenRefs(doc([el], { numberModes: [{ id: "compact", name: "Compact" }] }));
    expect(gap.message).toContain('numberMode "tiny"');
    expect(validateTokenRefs(doc([card({ numberMode: "compact" })], { numberModes: [{ id: "compact", name: "Compact" }] }))).toEqual([]);
  });

  it("reports an activeNumberMode the number axis does not declare", () => {
    const [gap] = validateTokenRefs(doc([], { activeNumberMode: "compact" }));
    expect(gap.message).toContain("activeNumberMode");
  });

  // The split has no compatibility window (plan §6): a token reference pointing
  // at a style is a writer bug from the first load, not a document to be read
  // leniently. The read path now looks a `tokenId` up in doc.tokens[] only, so a
  // warning here would be describing a reference that can never resolve as a
  // thing that "keeps working".
  it("treats a style-backed token reference as an ERROR, with no migration window", () => {
    const el = card({ fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_bg" }] });
    const [gap] = validateTokenRefs(doc([el], { styles: [TOKEN] }));
    expect(gap.level).toBe("error");
    expect(gap.message).toContain("doc.styles[]");
    expect(gap.message).toContain("doc.tokens[]");
  });

  it("still warns when nothing in either table backs the reference", () => {
    const el = card({ tokenBindings: { borderRadius: "num_gone" } });
    const [gap] = validateTokenRefs(doc([el]));
    expect(gap.level).toBe("warning");
    expect(gap.message).toContain("doc.tokens[]");
  });
});

describe("validateDocument", () => {
  it("carries the token gaps through, so `fish check` reports them", () => {
    const el = card({ fillStyleId: "style_gone" });
    expect(validateDocument(doc([el])).some((d) => d.message.includes("style_gone"))).toBe(true);
  });

  it("does not turn a dangling reference into an error", () => {
    const el = card({ fillStyleId: "style_gone" });
    expect(validateDocument(doc([el])).filter((d) => d.level === "error")).toEqual([]);
  });
});
