---
name: fish-design
description: Create, edit, and verify FISH vector designs (*.fish.html). Use for Figma-style layouts, posters, decks, icons, and component systems in the self-contained FISH document format.
---

# FISH Vector Design

FISH is a single-file vector design engine. A `.fish.html` file carries its document in `<script id="design-doc" type="application/json">` (`DesignDocument v0.1`) and its runtime in the same file.

This skill is the entry point and index. The DSL reference, workflow and asset guide live in the kit, so they stay on the version that matches its tools.

## Get the kit

Download the kit release that matches this skill and unpack it into the workspace:

```bash
curl -L "{{KIT_URL}}" -o fish-agent-kit.zip
unzip -q fish-agent-kit.zip -d .fish-agent-kit
```

If `references/` and `tools/` are already beside this file, the kit is already present.

The URL is versioned, never `latest`: `sha256sums.txt` in the same release lists the
zip's SHA-256, so check the download before unzipping.

The kit is self-contained: Node plus a local browser for rendering. There is no `npm install`, no package manager step, and no network requirement beyond the asset sources you choose to use.

## Read in this order

1. **`references/workflow.md`** — how to work: `/fast` vs `/craft`, HTML import vs compact JSON, ops, verification, and the pre-flight checklist.
2. **`references/dsl.md`** — the document model, tokens and styles, element primitives, CSS deltas, paint, typography, components, and silent traps. Read it before writing JSON.
3. **`references/assets.md`** — only when the job needs real photos or icons: available sources, credentials, licences, link vs embedded bytes, and the image ceiling.

`tools/fish.schema.json` is the published contract for accepted keys and enums. `./tools/fish check` is the executable truth. If this documentation and the engine disagree, the engine wins.

## Hard rules

- **Never regex-replace a `.fish.html` file.** Edit through `./tools/fish apply` / `compose`, or modify only the `#design-doc` block (and `#fish-assets` when present). The runtime blocks `#fish-rt-css`, `#fish-rt` and the inline loader must stay untouched.
- **Verify before handing over.** Run `./tools/fish check <doc> --geometry`; render with `./tools/shot.sh` (`shot.ps1` on Windows) when the picture matters.
- **Never hand-draw photos, logos or portraits.** Source a real asset or ask the user for one.
- **Do not invent a separate design-system document.** The document's `tokens[]` and `styles[]` are the system; `./tools/fish brief` reports what already exists.
- **Repeated structure is a component.** If a card, button, row or nav item appears more than once, make one `component` master and place `instance`s; do not duplicate frames.
- **Theme changes live on tokens.** Declare `modes[]` + `activeTheme`, put per-mode values on colour tokens (`tokens[].modes`); number tokens have their own axis (`numberModes[]` + `activeNumberMode`) for density variants; never duplicate styles per theme.
- **Prefer the kit's CLI over browser automation**, and keep assets embedded when the file must open offline.
