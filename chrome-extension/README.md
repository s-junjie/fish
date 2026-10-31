# FISH Capture — Chrome Extension (HTML to Design)

A Chrome extension to capture any web element or entire page and paste directly into FISH as editable vector design layers.

---

## Features

- **Pick Element (Hover Inspect)**: Hover over any button, navigation bar, hero section, or card on any website. Real-time amber bounding box and dimension pill display. Click to capture.
- **Capture Full Page**: One-click snapshot of the entire rendered page layout and styles.
- **High Fidelity**: Automatically collects document stylesheets, inlines computed dimensions, and resolves relative image/asset URLs.
- **Instant Paste**: Copies into the clipboard with the `fish-html-clip` protocol. Switch to FISH, press **`⌘V`** (or `Ctrl+V`), and it immediately lands on your active canvas as an editable, Auto-Layout-ready vector Frame.

---

## Installation (Developer / Unpacked Mode)

1. Open Google Chrome (or any Chromium browser such as Edge, Arc, Brave).
2. Navigate to `chrome://extensions/`.
3. Toggle on **Developer mode** in the top right corner.
4. Click **Load unpacked** in the top left.
5. Select this `chrome-extension/` directory.

---

## How to Use

1. Go to any webpage you want to capture (e.g. GitHub, Stripe, Tailwind UI, Apple).
2. Click the **FISH Capture** extension icon in your toolbar.
3. Choose:
   - **Pick Element**: Hover and click the target component on the page.
   - **Capture Full Page**: Copy the whole document layout.
4. Open your FISH design document (e.g. `dist/index.html` or your `.fish.html` file).
5. Press **`⌘V`** (`Ctrl+V` on Windows) to paste.
6. The captured element is converted into editable frames, text layers, vector rectangles, and styles!

---

## Versioning

`manifest.json`'s `version` is the EXTENSION's own, not FISH's: it moves when this folder does, and an app release does not touch it. Nothing in the build or the release pipeline reads it (`scripts/build-chrome-extension.mjs` copies the folder verbatim), so the two numbers are expected to disagree — `chrome://extensions` shows this one.

Chrome wants one to four dot-separated integers and, once the extension is published to the Web Store, a strictly increasing value. It is loaded unpacked today, so `1.0.0` is a clean start of that line rather than a claim about FISH.

