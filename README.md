# FISH — Figma In a Single HTML

FISH is a modern, high-performance vector design editor that lives entirely inside a single standalone HTML file.

Open it in Chrome, create professional vector designs, save directly to your local disk, or send the file to anyone. **No installation, no account, no cloud lock-in, and zero external dependencies.**

[**Official Website**](https://fish.themindstudio.cc) • [**Live Editor**](https://dl.fish.themindstudio.cc/stable/fish.html) • [**Agent Kit**](#2-design-with-ai-agents-agent-kit) • [**Releases**](https://github.com/s-junjie/fish/releases/latest)

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

### 1. Instant Start (Zero Installation)

FISH requires no installation, accounts, or cloud setup:

1. **Open the editor**: Visit the [official website](https://fish.themindstudio.cc) or launch [`fish.html`](https://dl.fish.themindstudio.cc/stable/fish.html) directly in **Google Chrome** (or Chromium-based browsers).
2. **Enable auto-save**: Click the **"Grant Access"** button in the top toolbar to authorize writing to your `.fish.html` file.
   > **Why?** Due to browser sandbox security policies, Chromium's File System Access API requires explicit user consent before allowing a local page to modify files on your disk. Granting permission allows FISH to save changes directly back to your file in place and auto-save silently as you edit — zero duplicate downloads, zero cloud upload, and completely private.
3. **Create & Save**: Press `F` to create Frames, `R` for Rectangles, `T` for Typography, or drag and drop SVGs, images, and HTML files onto the canvas. Press `Cmd + S` (macOS) or `Ctrl + S` (Windows/Linux) to save in place anytime.

### 2. Design with AI Agents (Agent Kit)

FISH is built to be agent-native. AI coding agents (Claude Code, ChatGPT, Cursor, etc.) can inspect, generate, and verify `.fish.html` vector documents programmatically.

#### Install the Skill

Add the FISH skill to your agent environment:

```bash
npx skills add https://dl.fish.themindstudio.cc/stable/fish-agent-kit.zip --skill fish-design -y
```

*(Alternatively, paste `https://fish.themindstudio.cc/skill.md` into ChatGPT, Claude, or any chat that can read a link. Or download the kit from [Releases](https://github.com/s-junjie/fish/releases/latest)).*

#### Sample Prompt for Your Agent

Once the skill is installed, simply point your agent at what you have and tell it which file to make:

> *"Use the fish-design skill. Read brand.md and the photos in assets/shots/. Design a pricing page for a two-person photo studio, three plans, the middle one highlighted. Save it as pricing.fish.html."*

The agent will read the DSL guidelines, construct the vector document, validate the layout headlessly, and hand over a ready-to-open `pricing.fish.html` file.

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

## Contributing

Issues and pull requests are welcome. For repo conventions (design tokens, i18n, testing rigs, file-size discipline), read [`AGENTS.md`](AGENTS.md) first — contributors and agents work under the same rules.

---

## License

The source code is released under the **Apache License 2.0** — see the [`LICENSE`](LICENSE) file and the [`NOTICE`](NOTICE) file.

**Brand reservation**: The product name "FISH", its logo, wordmark, and associated brand assets are **not** covered by the open-source license — all rights are reserved, and using them (including on forks or redistributions) requires prior written permission. Forks must carry their own distinct branding.
