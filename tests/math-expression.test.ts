import { describe, it, expect } from "vitest";
import { evaluateMathExpression } from "../src/ui/math-expression";

describe("evaluateMathExpression", () => {
  it("reads a plain number as itself", () => {
    expect(evaluateMathExpression("1000")).toBe(1000);
    expect(evaluateMathExpression("-3.5")).toBe(-3.5);
    expect(evaluateMathExpression(".5")).toBe(0.5);
    expect(evaluateMathExpression("1e3")).toBe(1000);
    expect(evaluateMathExpression("  42  ")).toBe(42);
  });

  it("does not round a hand-typed number", () => {
    expect(evaluateMathExpression("0.123456789")).toBe(0.123456789);
  });

  it("evaluates the arithmetic the user asked for", () => {
    expect(evaluateMathExpression("1000/2")).toBe(500);
    expect(evaluateMathExpression("100*1.5")).toBe(150);
    expect(evaluateMathExpression("50+50")).toBe(100);
    expect(evaluateMathExpression("1000-1")).toBe(999);
    expect(evaluateMathExpression("(100+20)/2")).toBe(60);
    expect(evaluateMathExpression("1000 / 2")).toBe(500);
  });

  it("honours precedence, associativity and unary signs", () => {
    expect(evaluateMathExpression("2+3*4")).toBe(14);
    expect(evaluateMathExpression("(2+3)*4")).toBe(20);
    expect(evaluateMathExpression("-1000/2")).toBe(-500);
    expect(evaluateMathExpression("1000/-2")).toBe(-500);
    expect(evaluateMathExpression("2^3")).toBe(8);
    expect(evaluateMathExpression("2^3^2")).toBe(512);
    expect(evaluateMathExpression("-2^2")).toBe(-4);
  });

  it("cleans the floating-point noise an expression leaves behind", () => {
    expect(evaluateMathExpression("0.1+0.2")).toBe(0.3);
    expect(evaluateMathExpression("100*0.1")).toBe(10);
  });

  it("returns null for anything that is not a complete expression", () => {
    expect(evaluateMathExpression("")).toBeNull();
    expect(evaluateMathExpression("   ")).toBeNull();
    expect(evaluateMathExpression("abc")).toBeNull();
    expect(evaluateMathExpression("1000/")).toBeNull();
    expect(evaluateMathExpression("(1+2")).toBeNull();
    expect(evaluateMathExpression("1000/2px")).toBeNull();
    expect(evaluateMathExpression("1000/2 2")).toBeNull();
    expect(evaluateMathExpression("0x10")).toBeNull();
  });

  it("refuses a result no field can hold", () => {
    expect(evaluateMathExpression("1/0")).toBeNull();
    expect(evaluateMathExpression("0/0")).toBeNull();
  });
});
