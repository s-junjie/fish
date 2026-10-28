import { describe, expect, it } from "vitest";
import { injectPluginStyles } from "../src/core/plugins/plugin-styles";

interface StyleElement {
  attributes: Record<string, string>;
  textContent: string;
}

function fakeDocument() {
  const appended: StyleElement[] = [];
  const doc = {
    head: {
      appendChild: (element: StyleElement) => appended.push(element)
    },
    createElement: () => {
      const element = {
        attributes: {} as Record<string, string>,
        textContent: "",
        setAttribute(name: string, value: string) {
          element.attributes[name] = value;
        }
      };
      return element;
    }
  };
  return { doc: doc as unknown as Document, appended };
}

describe("plugin style injection", () => {
  it("injects one style element per stylesheet", () => {
    const { doc, appended } = fakeDocument();
    const css = ".fish-test-once{color:red}";

    injectPluginStyles(css, doc);
    injectPluginStyles(css, doc);

    expect(appended).toHaveLength(1);
    expect(appended[0].textContent).toBe(css);
    expect(appended[0].attributes["data-fish-plugin-styles"]).toBe("");
  });

  it("ignores empty stylesheets", () => {
    const { doc, appended } = fakeDocument();
    injectPluginStyles("   ", doc);
    expect(appended).toHaveLength(0);
  });

  it("does nothing when there is no document to write to", () => {
    expect(() => injectPluginStyles(".fish-test-headless{}", {} as Document)).not.toThrow();
  });
});
