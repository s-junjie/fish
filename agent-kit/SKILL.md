---
name: fish-design
description: Create, edit, and verify FISH vector designs (*.fish.html). Use for Figma-style layouts, posters, decks, icons, and component systems in the self-contained FISH document format.
metadata:
  version: "{{SKILL_VERSION}}"
  documentDialect: "{{DOC_VERSION}}"
---

# FISH Vector Design

FISH is a single-file vector design engine. A `.fish.html` file carries its document in `<script id="design-doc" type="application/json">` (`DesignDocument v{{DOC_VERSION}}`) and its runtime in the same file.

**This skill is written for FISH {{SKILL_VERSION}}** (document dialect {{DOC_VERSION}}), and the kit beside it is the same release — `./tools/fish --version` prints the copy you actually have. The tool compares that number with this frontmatter before every command and exits non-zero instead of running when they disagree: the prose and the engine are then two releases wearing one directory. Never edit either number and never work around the refusal — re-run the install command.

It refuses a `.fish.html` whose document dialect is not {{DOC_VERSION}} for the same reason a dialect does not migrate: that file belongs to a different FISH. Re-install rather than translating the document.

`./tools/fish --version --check` asks the release origin whether a newer FISH is published. Run it when a document or a request uses something this kit does not have — an op it rejects, a key it does not know — rather than concluding the document is wrong.

This skill is the entry point and index. The DSL reference, workflow and asset guide live in the kit, so they stay on the version that matches its tools.

## Get the kit

Two ways in; use whichever your runtime can do.

**Install it as a skill** — one command, into any agent that reads `SKILL.md`:

```bash
npx skills add "{{KIT_STABLE_URL}}" --skill fish-design -y
```

**Or download and unpack it by hand**, into the directory you will work in:

```bash
curl -L "{{KIT_URL}}" -o fish-agent-kit.zip
{{KIT_CHECKSUM_BLOCK}}
unzip -q fish-agent-kit.zip -d .
chmod +x tools/fish tools/shot.sh
```

If `references/` and `tools/` are already beside this file, the kit is already present.

`./tools/fish` is a launcher for `tools/fish.cjs`. If an installer did not preserve the
executable bit, run `node tools/fish.cjs` (or `bash tools/fish`) instead.

`{{SKILL_PAGE_URL}}` is this page at its unversioned address; `{{KIT_STABLE_URL}}`
is the installer's pointer to the current archive. Both move with a release; the
versioned files they name never do.

The kit is self-contained: Node plus a local browser for rendering. There is no `npm install`, no package manager step, and no network requirement beyond the asset sources you choose to use — the tool asks its own origin for a newer release at most once a day, and behaves identically when it cannot reach it.

## Read in this order

{{SKILL_REFERENCES_ONLINE}}

1. **`references/workflow.md`** — how to work: `/fast` vs `/craft`, HTML import vs compact JSON, ops, verification, and the pre-flight checklist.
2. **`references/dsl.md`** — the document model, tokens and styles, element primitives, CSS deltas, paint, typography, components, and silent traps. Read it before writing JSON.
3. **`references/assets.md`** — only when the job needs real photos or icons: available sources, credentials, licences, link vs embedded bytes, and the image ceiling.

`tools/fish.schema.json` is the published contract for accepted keys and enums. `./tools/fish check` is the executable truth. If this documentation and the engine disagree, the engine wins.

## Hard rules

- **Never regex-replace a `.fish.html` file.** Edit through `./tools/fish apply` / `compose`, or modify only the `#design-doc` block (and `#fish-assets` when present). The runtime blocks `#fish-rt-css`, `#fish-rt` and the inline loader must stay untouched.
- **Verify before handing over.** Always `./tools/fish check <doc>` — structure, Node only, no browser. Add `--geometry`, and `./tools/shot.sh` (`shot.ps1` on Windows) when the picture is the deliverable, once the draft is promoted to a full pass: Fast mode hands over after the structure gate alone (`references/workflow.md` §6).
- **Never hand-draw photos, logos or portraits.** Ask the user for their own material first (moodboard, brand files, product shots, fonts); source a real asset only when they have none.
- **Do not invent a separate design-system document.** The document's `tokens[]` and `styles[]` are the system; `./tools/fish brief` reports what already exists.
- **Repeated structure is a component.** If a card, button, row or nav item appears more than once, make one `component` master and place `instance`s; do not duplicate frames.
- **Theme changes live on tokens.** Declare `modes[]` + `activeTheme`, put per-mode values on colour tokens (`tokens[].modes`); number tokens have their own axis (`numberModes[]` + `activeNumberMode`) for density variants; never duplicate styles per theme.
- **Prefer the kit's CLI over browser automation**, and keep assets embedded when the file must open offline.
