/**
 * The `fish check` verdict: a repair that only RECORDS a default the engine
 * supplied (severity "info") must not fail the check, while a repair that
 * dropped, ignored or reinterpreted authored input must. A document omitting
 * `canvas` is the case that proved it — it normalized cleanly and still exited
 * 1, so `check` called a perfectly good file broken.
 */

import { describe, expect, it } from "vitest";
import { checkVerdict } from "../src/core/check-verdict";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

describe("checkVerdict", () => {
  it("passes when the only repairs are info", () => {
    expect(checkVerdict([{ kind: "canvas", path: "/canvas", severity: "info", message: "canvas was missing" }], 0, 0, false).ok).toBe(true);
  });

  it("fails on a lossy repair", () => {
    const v = checkVerdict([{ kind: "dropped-property", path: "/x", message: "dropped" }], 0, 0, false);
    expect(v.ok).toBe(false);
    expect(v.lossy).toBe(1);
    expect(v.failReason).toBe(" (repairs)");
  });

  it("fails only under --strict for warnings", () => {
    expect(checkVerdict([], 0, 1, false).ok).toBe(true);
    expect(checkVerdict([], 0, 1, true).failReason).toBe(" (--strict)");
  });

  it("lets an error explain the failure before repairs do", () => {
    expect(checkVerdict([], 2, 0, false).failReason).toBe("");
  });
});

describe("a document with no canvas is 'ok'", () => {
  it("normalizes with only info repairs and passes the check", () => {
    const { repairs } = normalizeDesignDocument({ pages: [{ id: "p1", name: "P", children: [] }], activePageId: "p1" });
    expect(repairs.every((r) => r.severity === "info")).toBe(true);
    expect(checkVerdict(repairs, 0, 0, false).ok).toBe(true);
  });
});
