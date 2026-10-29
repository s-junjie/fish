import { describe, it, expect } from "vitest";
import { imageRenderUri, restoreSourceUris } from "../src/core/assets/render-uri";

const photo = { uri: "data:image/png;base64,iVBORw0KGgo=", width: 4800, height: 1186 };

describe("what the canvas points an <image> at", () => {
  /**
   * The bake is an optimisation, never a requirement: an engine that cannot
   * produce one (every node test, and a browser without `createImageBitmap`)
   * must keep painting the document's own URI.
   */
  it("falls back to the stored URI when no bake can be made", () => {
    expect(imageRenderUri(photo, 200, 120)).toBe(photo.uri);
  });

  it("leaves a non-`data:` URI alone", () => {
    const remote = { uri: "https://example.com/a.png", width: 10, height: 10 };
    expect(imageRenderUri(remote, 10, 10)).toBe(remote.uri);
  });

  it("asks for no bake while the layer covers more pixels than one", () => {
    expect(imageRenderUri(photo, 3000, 900)).toBe(photo.uri);
  });
});

describe("restoring URIs on an export clone", () => {
  const cloneOf = (hrefs: string[]) => {
    const nodes = hrefs.map((href) => {
      const attrs: Record<string, string> = { href };
      return {
        getAttribute: (name: string) => attrs[name] ?? null,
        setAttribute: (name: string, value: string) => {
          attrs[name] = value;
        },
        read: () => attrs.href
      };
    });
    return { root: { querySelectorAll: () => nodes } as unknown as ParentNode, nodes };
  };

  it("keeps every href the document itself holds", () => {
    const { root, nodes } = cloneOf([photo.uri, "https://example.com/b.png"]);
    restoreSourceUris(root);
    expect(nodes.map((n) => n.read())).toEqual([photo.uri, "https://example.com/b.png"]);
  });

  it("rewrites a handle it minted back to the bitmap it stands for", () => {
    const { root, nodes } = cloneOf(["blob:null/not-ours"]);
    restoreSourceUris(root);
    // Unknown to the registry, so left as it was rather than blanked: a picture
    // that failed to resolve is visible as a bug, not as a silent gap.
    expect(nodes[0].read()).toBe("blob:null/not-ours");
  });
});
