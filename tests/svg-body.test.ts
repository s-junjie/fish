import { describe, it, expect } from "vitest";
import { parseIconBody } from "../src/core/assets/svg-body";
import lucideFixture from "./fixtures/iconify-lucide.json";
import remixFixture from "./fixtures/iconify-ri.json";

/**
 * The converter is the boundary between markup somebody else wrote and one
 * `path` element. Every case below is a shape that appears in the two shipped
 * sets, and each one failed at least once while the fixtures were being built:
 * the `<g>` that carries the paint, the dash in `stroke-linecap` against a
 * camelCase field name, the implicit relative moveto, and the alias.
 */

const lucide = lucideFixture as { icons: Record<string, { body: string }>; aliases: Record<string, { parent: string }> };
const remix = remixFixture as { icons: Record<string, { body: string }> };

const geom = (name: string) => {
  const g = parseIconBody(lucide.icons[name].body);
  expect(g, name).not.toBeNull();
  return g!;
};

describe("parseIconBody", () => {
  it("reads a bare path with no wrapper", () => {
    const g = geom("x");
    expect(g.mode).toBe("stroke");
    expect(g.d).toMatch(/^M/);
  });

  it("takes the paint from the <g>, not from the shape it wraps", () => {
    // `search` is `<g fill="none" stroke="currentColor" stroke-linecap="round"
    // stroke-linejoin="round" stroke-width="2"><path/><circle/></g>` — every
    // attribute the renderer needs is on the group and on no child.
    const g = geom("search");
    expect(g.mode).toBe("stroke");
    expect(g.strokeWidth).toBe(2);
    expect(g.cap).toBe("round");
    expect(g.join).toBe("round");
  });

  it("converts a circle into path data", () => {
    const g = geom("circle");
    expect(g.d).toMatch(/^M/);
    expect(g.d.length).toBeGreaterThan(20);
  });

  it("converts a rounded rect, clamping the radius to the box", () => {
    const g = geom("credit-card");
    expect(g.d).toMatch(/^M/);
    expect(g.d).not.toMatch(/NaN/);
  });

  it("converts an ellipse", () => {
    const g = geom("database");
    expect(g.d).toMatch(/^M/);
  });

  it("resolves each shape's own relative moveto from the origin, not the last shape", () => {
    // `accessibility` is a circle plus a path opening `m18 19l1-7l-6 1`. Run
    // through the parser on its own that is (18,19); joined onto the circle
    // first, a naive concatenation would start it at the circle's end point and
    // put the glyph 15 units off.
    const g = geom("accessibility");
    expect(g.d).toMatch(/M 18 19 /);
    expect(g.d).not.toMatch(/M 3\d /);
  });

  it("reads an interior rule and reports the set as solid", () => {
    // The only solid glyph Lucide ships, and the only one with a hole.
    const g = geom("search-large");
    expect(g.mode).toBe("fill");
    expect(g.fillRule).toBe("evenodd");
  });

  it("reads a solid set as a fill with no stroke", () => {
    const g = parseIconBody(remix.icons["home-4-line"].body);
    expect(g!.mode).toBe("fill");
    expect(g!.strokeWidth).toBeUndefined();
    expect(g!.cap).toBeUndefined();
    expect(g!.fillRule).toBeUndefined();
  });

  it("leaves every result fully absolute, so a second pass is a no-op", () => {
    for (const [name, icon] of Object.entries({ ...lucide.icons, ...remix.icons })) {
      const g = parseIconBody(icon.body);
      expect(g, name).not.toBeNull();
      expect(g!.d, `${name} kept a relative command`).not.toMatch(/[a-z]/);
    }
  });

  it("refuses a body it cannot represent rather than inserting a blank box", () => {
    expect(parseIconBody('<path d="M0 0" fill="url(#grad)"/>')).toBeNull();
    expect(parseIconBody('<mask><rect width="24" height="24"/></mask>')).toBeNull();
    expect(parseIconBody("")).toBeNull();
  });

  it("declares the two aliases the fixture set carries", () => {
    // A body arrives under the parent's name, so the alias is the only thing
    // that makes `home` findable at all.
    expect(lucide.aliases.home).toEqual({ parent: "house" });
    expect(lucide.icons[lucide.aliases.home.parent]).toBeTruthy();
    expect(lucide.aliases["trash-2"]).toEqual({ parent: "trash" });
  });
});
