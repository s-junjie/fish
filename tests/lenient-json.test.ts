import { describe, it, expect } from "vitest";
import { relaxJson, parseLenientJson } from "../src/core/dsl/lenient-json";

describe("relaxed JSON", () => {
  it("strips line comments without shifting the text", () => {
    const src = '{\n  "a": 1, // one\n  "b": 2\n}';
    expect(relaxJson(src)).toHaveLength(src.length);
    expect(parseLenientJson(src)).toEqual({ a: 1, b: 2 });
  });

  it("strips block comments and keeps newlines for error offsets", () => {
    const src = '{\n  /* note\n     more */\n  "a": 1\n}';
    expect(relaxJson(src).split("\n")).toHaveLength(src.split("\n").length);
    expect(parseLenientJson(src)).toEqual({ a: 1 });
  });

  it("drops a dangling comma before } and ]", () => {
    expect(parseLenientJson('{ "a": [1, 2,], }')).toEqual({ a: [1, 2] });
  });

  it("leaves comment-looking text inside strings alone", () => {
    const src = '{ "a": "http://x // y /* z */", "b": "," }';
    expect(parseLenientJson(src)).toEqual({ a: "http://x // y /* z */", b: "," });
  });

  it("reports the position of a real syntax error", () => {
    // The offsets only stay truthful because removed characters become spaces.
    expect(() => parseLenientJson('{\n  "a": 1\n  "b": 2\n}')).toThrow(/line 3 column 3/);
  });

  it("parses strict JSON unchanged", () => {
    const src = '{ "a": [1, 2, 3], "b": { "c": "d</e" } }';
    expect(parseLenientJson(src)).toEqual(JSON.parse(src));
  });
});
