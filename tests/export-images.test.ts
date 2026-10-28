import { describe, it, expect, vi } from "vitest";
import { inlineExternalImages } from "../src/core/export-images";

class MockSvgElement {
  tagName: string;
  attrs: Record<string, string> = {};
  children: MockSvgElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }

  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }

  hasAttribute(k: string): boolean {
    return k in this.attrs;
  }

  removeAttribute(k: string) {
    delete this.attrs[k];
  }

  appendChild(child: MockSvgElement) {
    this.children.push(child);
    return child;
  }

  querySelectorAll(tag: string): MockSvgElement[] {
    const out: MockSvgElement[] = [];
    if (this.tagName.toLowerCase() === tag.toLowerCase()) out.push(this);
    for (const child of this.children) {
      out.push(...child.querySelectorAll(tag));
    }
    return out;
  }
}

describe("inlineExternalImages", () => {
  it("does nothing if there are no external http/https images", async () => {
    const svg = new MockSvgElement("svg");
    const image = new MockSvgElement("image");
    image.setAttribute("href", "data:image/png;base64,abc");
    svg.appendChild(image);

    await inlineExternalImages(svg as unknown as SVGSVGElement);
    expect(image.getAttribute("href")).toBe("data:image/png;base64,abc");
  });

  it("converts http/https image href to data URI via fetch", async () => {
    const svg = new MockSvgElement("svg");
    const image = new MockSvgElement("image");
    image.setAttribute("href", "https://example.com/photo.png");
    svg.appendChild(image);

    const fakeBlob = new Blob(["fake-image-bytes"], { type: "image/png" });
    const originalFetch = globalThis.fetch;
    const originalFileReader = globalThis.FileReader;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => fakeBlob
    } as any);

    class MockFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(_blob: Blob) {
        this.result = "data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==";
        setTimeout(() => this.onload?.(), 0);
      }
    }
    (globalThis as any).FileReader = MockFileReader;

    try {
      await inlineExternalImages(svg as unknown as SVGSVGElement);
      const href = image.getAttribute("href") ?? "";
      expect(href).toBe("data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.FileReader = originalFileReader;
    }
  });

  it("handles duplicate URLs with a single fetch and updates all elements", async () => {
    const svg = new MockSvgElement("svg");
    const img1 = new MockSvgElement("image");
    img1.setAttribute("href", "https://example.com/shared.png");
    const img2 = new MockSvgElement("image");
    img2.setAttribute("href", "https://example.com/shared.png");
    svg.appendChild(img1);
    svg.appendChild(img2);

    const fakeBlob = new Blob(["shared-bytes"], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => fakeBlob
    } as any);
    const originalFetch = globalThis.fetch;
    const originalFileReader = globalThis.FileReader;

    globalThis.fetch = fetchMock;
    class MockFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(_blob: Blob) {
        this.result = "data:image/png;base64,c2hhcmVk";
        setTimeout(() => this.onload?.(), 0);
      }
    }
    (globalThis as any).FileReader = MockFileReader;

    try {
      await inlineExternalImages(svg as unknown as SVGSVGElement);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(img1.getAttribute("href")).toBe(img2.getAttribute("href"));
      expect(img1.getAttribute("href")).toBe("data:image/png;base64,c2hhcmVk");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.FileReader = originalFileReader;
    }
  });

  it("falls back to wsrv.nl proxy when direct fetch fails", async () => {
    const svg = new MockSvgElement("svg");
    const img = new MockSvgElement("image");
    img.setAttribute("href", "https://i.pinimg.com/236x/5a/bd/94/test.jpg");
    svg.appendChild(img);

    const fakeBlob = new Blob(["proxy-image-bytes"], { type: "image/jpeg" });
    const originalFetch = globalThis.fetch;
    const originalFileReader = globalThis.FileReader;

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("https://i.pinimg.com")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (url.startsWith("https://wsrv.nl/?url=")) {
        return Promise.resolve({
          ok: true,
          blob: async () => fakeBlob
        });
      }
      return Promise.reject(new Error("Unknown url"));
    });

    globalThis.fetch = fetchMock;
    class MockFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(_blob: Blob) {
        this.result = "data:image/jpeg;base64,cHJveHk=";
        setTimeout(() => this.onload?.(), 0);
      }
    }
    (globalThis as any).FileReader = MockFileReader;

    try {
      await inlineExternalImages(svg as unknown as SVGSVGElement);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe("https://i.pinimg.com/236x/5a/bd/94/test.jpg");
      expect(fetchMock.mock.calls[1][0]).toBe("https://wsrv.nl/?url=https%3A%2F%2Fi.pinimg.com%2F236x%2F5a%2Fbd%2F94%2Ftest.jpg");
      expect(img.getAttribute("href")).toBe("data:image/jpeg;base64,cHJveHk=");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.FileReader = originalFileReader;
    }
  });
});
