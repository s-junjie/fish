# FISH — Figma In a Single HTML

FISH is a modern, high-performance vector design editor that lives entirely inside a single standalone HTML file.

Open it in Chrome, create professional vector designs, save directly to your local disk, or send the file to anyone. **No installation, no account, no cloud lock-in, and zero external dependencies.**

---

## Highlights

- **Single-File Self-Contained Document**: Your designs, components, assets, and the full vector editor runtime are packaged together into a single `*.fish.html` file.
- **Figma-Grade Vector Editing**: Frames, Auto-Layout (flex and grid stacks), typography, complex vector paths, boolean operations, and modern multi-layer paint stacks (gradients, image fills, blend modes).
- **Local-First & Private**: Direct file access via the File System Access API (Chromium only). Everything stays on your local machine with automatic backup protection and local version history.
- **Full Offline Portability**: Works completely offline. Double-click the file to open your canvas anywhere, on any modern operating system.
- **Self-Updating Files**: A `.fish.html` file can pull a newer editor shell and re-pour your document into it. 

---

## What's Not Included (Yet)

- **No Real-Time Collaboration (Yet)**: FISH is strictly local-first and single-player for now. There is no cloud backend, multi-user live cursors, or shared editing.
- **No Interactive Prototyping**: Slide presentations are supported, but interactive prototyping (state transitions, click triggers, and micro-interactions) is not supported.
- **No Multi-Language Yet**: The workbench currently operates only in English (internationalization dictionary and locale switching are not yet exposed).

---

## Quick Start

to be added

---

## Browser Support

**Chrome is the only browser FISH is optimised for.** Every behaviour is developed and verified there.

Other Chromium browsers — Edge, Brave, Arc, Opera — expose the same APIs and behave like Chrome. Safari and Firefox open, edit and export documents, but the two features built on Chromium-only APIs are not available:

| Feature | API it needs | Chrome / Edge | Safari | Firefox |
|---|---|---|---|---|
| Write back to the file you opened, auto-save | File System Access API | ✅ | ❌ `Cmd+S` downloads a copy | ❌ `Cmd+S` downloads a copy |
| Your installed fonts in the font menu | Local Font Access API | ✅ | ❌ built-in presets only | ❌ built-in presets only |

Without the font API the menu offers the built-in presets, and any preset whose face is not installed falls back to your system font.

Everything else — the canvas, vector editing, components, auto-layout, effects, import and export — is plain web platform and works in all four.

---

## Build From Source

```bash
npm install
npm run dev      # start the dev server
npm run build    # emit the single-file shell into dist/
```

The build produces the standalone editor shell (`dist/index.html`), which is itself a runnable `*.fish.html` container.

---

## Contributing

Issues and pull requests are welcome. For repo conventions (design tokens, i18n, testing rigs, file-size discipline), read [`AGENTS.md`](AGENTS.md) first — contributors and agents work under the same rules.

---

## License

The source code is released under the **Apache License 2.0** — see the [`LICENSE`](LICENSE) file and the [`NOTICE`](NOTICE) file.

**Brand reservation**: The product name "FISH", its logo, wordmark, and associated brand assets are **not** covered by the open-source license — all rights are reserved, and using them (including on forks or redistributions) requires prior written permission. Forks must carry their own distinct branding.
