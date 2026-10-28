import { describe, it, expect } from "vitest";
import { dragPayload, ASSET_MIME } from "../src/core/plugins";

/**
 * A panel outlives the shell's knowledge of it, but a drag does not: the payload
 * names a `providerId`, and the canvas resolves that id against the providers the
 * host installed. So the format is a host contract, not a plugin's private
 * business — which is why it is pinned here rather than inside a plugin's tests.
 */
describe("asset drag payload", () => {
  it("carries the asset under the MIME the canvas listens for", () => {
    let mimeSet = "";
    let dataSet = "";
    const fakeEvent = {
      dataTransfer: {
        setData: (mime: string, val: string) => {
          mimeSet = mime;
          dataSet = val;
        },
        effectAllowed: "none" as string
      }
    };

    dragPayload(fakeEvent as never, { providerId: "lucide", result: { id: "zap", name: "Zap" } });

    expect(mimeSet).toBe(ASSET_MIME);
    expect(JSON.parse(dataSet)).toEqual({ providerId: "lucide", result: { id: "zap", name: "Zap" } });
    expect(fakeEvent.dataTransfer.effectAllowed).toBe("copy");
  });
});
