import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildChromeExtension } from "../scripts/build-chrome-extension.mjs";

describe("Chrome Extension", () => {
  const extDir = path.resolve(__dirname, "../chrome-extension");
  const distDir = path.resolve(__dirname, "../dist-plugins/chrome-extension");

  it("manifest.json defines background service worker and host permissions", () => {
    const manifestPath = path.join(extDir, "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background?.service_worker).toBe("background.js");
    expect(manifest.host_permissions).toContain("<all_urls>");
    expect(manifest.permissions).toContain("clipboardWrite");
    expect(manifest.content_scripts?.[0]?.js).toContain("content.js");
  });

  it("background.js exists and defines message listeners for inlining images", () => {
    const bgPath = path.join(extDir, "background.js");
    expect(fs.existsSync(bgPath)).toBe(true);
    const content = fs.readFileSync(bgPath, "utf-8");
    expect(content).toContain("inline-images");
    expect(content).toContain("fetchImageAsDataUrl");
    expect(content).toContain("bufferToBase64");
  });

  it("content.js contains image inlining pipeline for <img>, SVG and backgrounds", () => {
    const contentPath = path.join(extDir, "content.js");
    expect(fs.existsSync(contentPath)).toBe(true);
    const content = fs.readFileSync(contentPath, "utf-8");
    expect(content).toContain("inlineImages");
    expect(content).toContain("resolveAbsoluteUrl");
    expect(content).toContain("blobToDataUrl");
    expect(content).toContain("backgroundImage");
    expect(content).toContain("removeAttribute(\"srcset\")");
  });

  it("buildChromeExtension copies background.js, manifest.json and content.js to dist", () => {
    buildChromeExtension();
    expect(fs.existsSync(path.join(distDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(distDir, "background.js"))).toBe(true);
    expect(fs.existsSync(path.join(distDir, "content.js"))).toBe(true);
    expect(fs.existsSync(path.join(distDir, "popup.html"))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf-8"));
    expect(manifest.background?.service_worker).toBe("background.js");
  });
});
