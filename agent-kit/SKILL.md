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
executable bit, run `node tools/fish.cjs` (or `bash tools/fish`) instead. When working
from a separate project directory, invoke `<kit-dir>/tools/fish` (or `node <kit-dir>/tools/fish.cjs`)
against that project's `.fish.html` files.

`{{SKILL_PAGE_URL}}` is this page at its unversioned address; `{{KIT_STABLE_URL}}`
is the installer's pointer to the current archive. Both move with a release; the
versioned files they name never do.

The kit is self-contained: Node plus a local browser for rendering. There is no `npm install`, no package manager step, and no network requirement beyond the asset sources you choose to use — the tool asks its own origin for a newer release at most once a day, and behaves identically when it cannot reach it.

## Read in this order

{{SKILL_REFERENCES_ONLINE}}

1. **`references/workflow.md`** — how to work: draft-first vs blueprint & polish, HTML import vs compact JSON, ops, verification, comments loop, and the pre-flight checklist.
2. **`references/dsl.md`** — the document model, tokens and styles, element primitives, CSS deltas, paint, typography, components, and silent traps. Read before writing or structurally authoring JSON.
3. **`references/assets.md`** — only when the job needs real photos or icons: available sources, credentials, licences, link vs embedded bytes, and the image ceiling.

Task routing: *answering comments (`comments pending/context`)?* Start with `workflow.md §7` and open `dsl.md` only for unfamiliar properties. *Importing HTML only?* Start with `workflow.md §2` + `dsl.md § HTML In`. *Authoring from scratch?* Read `workflow.md` + `dsl.md`.

`tools/fish.schema.json` publishes one spelling per key — the CSS name where CSS has one, the DSL name where it does not. Aliases are not published; never author a second spelling. It is a large reference file: **never read it whole** — list definitions and keys with `./tools/fish schema`, search by keyword with `./tools/fish schema --find <word>`, expand a type with `./tools/fish schema <Definition>`, or look up one key with `./tools/fish schema <key>` (`--json` for a machine; element aliases resolve to the published spelling). `./tools/fish --help` is the command syntax, `./tools/fish check` is the executable truth. If this documentation and the engine disagree, the engine wins.

## Hard rules

- **Version and dialect refusals are hard stops.** Never edit the version or dialect numbers, never work around a refusal, and never hand-translate a document across dialects — re-install the kit instead (`Get the kit`).
- **Mutate `.fish.html` only through the kit CLI.** Use `./tools/fish compose`, `apply`, `import`, `assets`, or `comments` — never regex-replace or hand-edit any block inside `.fish.html` (`#design-doc`, `#fish-assets`, `#fish-comments`, `#fish-rt-css`, `#fish-rt`, or the inline loader), and never use browser automation to drive the canvas GUI.
- **Answer comments in `#fish-comments`, never `#design-doc`.** For review threads (`comments pending`), write suggestions only with `comments suggest` / `reply` and run `./tools/fish check` on the applied result — never modify `#design-doc` behind an open editor tab.
- **HTML `import` is a one-way seed.** Iterate on an imported `.fish.html` with `apply`; never re-run `import` over an edited file or you will discard edits.
- **Ground media, systems, and schema in real sources.** Never approximate photos, portraits, or existing third-party marks with hand-drawn `<path>`s (in draft-first runs, place labelled placeholders and ask at handover; when aligning on a blueprint or polishing, ask for the user's material before searching — `references/workflow.md` §4 & §6). Never invent a separate design-system document (`tokens[]` and `styles[]` inside the file are the system; inspect with `./tools/fish brief` / `inspect` first). Never read `tools/fish.schema.json` whole — list with `./tools/fish schema`, search with `--find <word>`, or inspect one with `./tools/fish schema <key|Def>`.
- **Verify before handing over.** Always run `./tools/fish check <doc>` after document edits (`--geometry`, `--audit`, and `./tools/shot.sh` / `shot.ps1` for final or visual deliverables; `--strict-assets` with embedded assets whenever the file must open offline).
