import { describe, expect, it } from "vitest";
import { serializeSelf, createEmptyDocument } from "../src/core/data-bridge";
import { POLICY_META_NAME, READ_ONLY_POLICY, stampFilePolicy } from "../src/core/persistence/file-policy";

const SHELL = `<!DOCTYPE html><html><head><title>Shipped</title></head><body><div id="app"></div></body></html>`;
const FLAG = `<meta name="${POLICY_META_NAME}" content="${READ_ONLY_POLICY}">`;

describe("the read-only policy, as a stamp", () => {
  it("writes one meta into the head", () => {
    const html = stampFilePolicy(SHELL, true);
    expect(html).toContain(FLAG);
    expect(html.indexOf(FLAG)).toBeLessThan(html.indexOf("</head>"));
  });

  it("is idempotent — a re-save cannot end up with two answers", () => {
    const once = stampFilePolicy(SHELL, true);
    const twice = stampFilePolicy(once, true);
    expect(twice).toBe(once);
  });

  it("clears the flag when a save makes it untrue", () => {
    const html = stampFilePolicy(stampFilePolicy(SHELL, true), false);
    expect(html).not.toContain(POLICY_META_NAME);
    expect(html).toBe(SHELL);
  });
});

describe("a read-only file, as a save writes it", () => {
  it("carries the flag", () => {
    const html = serializeSelf(createEmptyDocument(), SHELL, { readOnly: true });
    expect(html).toContain(FLAG);
    expect(html.match(/fish:policy/g)).toHaveLength(1);
  });

  it("stays read-only when it is saved again", () => {
    const first = serializeSelf(createEmptyDocument(), SHELL, { readOnly: true });
    const second = serializeSelf(createEmptyDocument(), first, { readOnly: true });
    expect(second.match(/fish:policy/g)).toHaveLength(1);
  });

  it("is what an ordinary save does not produce", () => {
    expect(serializeSelf(createEmptyDocument(), SHELL)).not.toContain(POLICY_META_NAME);
  });
});
