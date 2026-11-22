import { describe, expect, it } from "vitest";
import {
  MAX_FIELD_DECIMALS,
  formatFieldNumber,
  roundFieldNumber
} from "../src/ui/field-number";

describe("field numbers", () => {
  it("collapses the float tails authored files carry", () => {
    expect(formatFieldNumber(-8.4399999999999)).toBe("-8.44");
    expect(formatFieldNumber(12.300000000000001)).toBe("12.3");
    expect(formatFieldNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatFieldNumber(100 / 3)).toBe("33.33");
  });

  it("keeps meaningful decimals and drops trailing zeros", () => {
    expect(formatFieldNumber(0.123)).toBe("0.12");
    expect(formatFieldNumber(12.3456)).toBe("12.35");
    expect(formatFieldNumber(-4)).toBe("-4");
    expect(formatFieldNumber(0)).toBe("0");
    expect(formatFieldNumber(-0)).toBe("0");
    expect(formatFieldNumber(undefined)).toBe("");
  });

  it("never shows more than the declared decimal cap", () => {
    const values = [
      -8.4399999999999,
      0.1 + 0.2,
      100 / 3,
      1e-7,
      1234.5678901234,
      -0.00009999999999999999,
      Number.MAX_SAFE_INTEGER / 7
    ];
    for (const n of values) {
      const shown = formatFieldNumber(n);
      const decimals = shown.split(".")[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(MAX_FIELD_DECIMALS);
    }
  });

  it("shows exactly the number a commit would store", () => {
    for (const n of [-8.4399999999999, 100 / 3, 0.123456789, 42]) {
      expect(Number(formatFieldNumber(n))).toBe(roundFieldNumber(n));
    }
  });
});
