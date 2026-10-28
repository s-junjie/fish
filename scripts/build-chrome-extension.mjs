import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "chrome-extension");
const distDir = path.join(root, "dist-plugins", "chrome-extension");

export function buildChromeExtension() {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(distDir, { recursive: true });

  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(distDir, file);
    if (fs.statSync(srcPath).isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  console.log("wrote dist-plugins/chrome-extension/ (manifest.json, popup.html, content.js, background.js)");
}

buildChromeExtension();
