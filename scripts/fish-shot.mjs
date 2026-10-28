#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { loadPlaywright } from "./lib/playwright-loader.mjs";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log("Usage: node scripts/fish-shot.mjs <file.fish.html> [scale] [out.png]");
  process.exit(0);
}

const targetPath = path.resolve(process.cwd(), args[0]);
if (!fs.existsSync(targetPath)) {
  console.error(`Error: File not found: ${targetPath}`);
  process.exit(1);
}

const scale = Math.max(1, Math.min(4, Number(args[1]) || 1));
const outPath = path.resolve(process.cwd(), args[2] || targetPath.replace(/\.html$/i, "") + (scale > 1 ? `@${scale}x.png` : ".png"));

const htmlContent = fs.readFileSync(targetPath, "utf-8");
let canvasWidth = 1920;
let canvasHeight = 1080;

const docMatch = htmlContent.match(/<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i);
if (docMatch) {
  try {
    const doc = JSON.parse(docMatch[1]);
    // The ACTIVE page's canvas, not `doc.canvas`. The editor sizes the artboard
    // from `getActivePage(doc).canvas`, so on a multi-page document the two
    // disagree and a shot framed on `doc.canvas` is the wrong rectangle — it
    // crops a short page and pads a tall one. `doc.canvas` is only the fallback
    // for a document with no pages, which is the same order the editor uses.
    const page = (doc.pages || []).find((p) => p.id === doc.activePageId) || doc.pages?.[0];
    const canvas = page?.canvas || doc.canvas;
    if (canvas?.width) canvasWidth = canvas.width;
    if (canvas?.height) canvasHeight = canvas.height;
  } catch (e) {
    // Ignore JSON parse errors, fallback to 1920x1080
  }
}

async function capture() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: canvasWidth, height: canvasHeight },
      deviceScaleFactor: scale
    });

    const fileUrl = `file://${targetPath}?view=canvas`;
    await page.goto(fileUrl, { waitUntil: "networkidle" });
    
    await page.waitForSelector("svg", { timeout: 5000 });
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: canvasWidth, height: canvasHeight } });

    const stats = fs.statSync(outPath);
    // The clip is canvas CSS pixels and the page carries deviceScaleFactor, so
    // the file is the canvas at `scale` — log those pixels, not the clip.
    console.log(`Saved screenshot (${Math.round(canvasWidth * scale)}x${Math.round(canvasHeight * scale)} @${scale}x, ${(stats.size / 1024).toFixed(1)} KB): ${outPath}`);
  } finally {
    await browser.close();
  }
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
