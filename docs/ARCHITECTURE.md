# FISH (Figma In a Single HTML) — Technical Architecture

## 1. Single-File Self-Executing Container Architecture

FISH packages the entire application runtime, stylesheets, icons, and document data into a single, standalone HTML file.

```
+--------------------------------------------------------------+
| *.fish.html Container                                        |
|                                                              |
|  1. HTML Head & Metas                                        |
|     <meta name="fish:fileId"> identifies the *file*          |
|  2. Embedded DSL Data Block:                                 |
|     <script id="design-doc" type="application/json">         |
|       { "docId": "...", "version": "0.1", "pages": [...] }   |
|     </script>                                                |
|  3. Bitmap Assets Block (omitted when empty):                |
|     <script id="fish-assets" type="application/json">        |
|       { "<assetId>": "data:image/..." }                      |
|     </script>                                                |
|  4. Payload Blocks (raw DEFLATE + base86, see §6):          |
|     <script id="fish-rt-css" type="fish/deflate-b86">           |
|     <script id="fish-rt"     type="fish/deflate-b86">           |
|  5. Loader (inline, synchronous, last element in <body>)       |
+--------------------------------------------------------------+
```

### 1.1 In-Place Data Bridge Lifecycle
1. **Boot**: `capturePristine()` captures initial DOM structure before runtime components mutate the page.
2. **Mount**: `loadInitialDocument()` parses `#design-doc`, resolves `#fish-assets`, and passes data through `normalizeDesignDocument`.
3. **Identity**: `getFileId()` reads `<meta name="fish:fileId">` from the DOM to key recovery snapshots and version history independently of `docId`.
4. **Save**: `serializeSelf(doc)` normalizes the document, extracts bitmap assets to `#fish-assets`, and updates container blocks. `writeFileSafely()` handles atomic disk writes with backup, falling back to a blob download when File System Access API is unavailable.

### 1.2 Format Versioning & Migration
- **Dialect Version**: `DesignDocument.version` represents the document dialect, single-sourced from `src/core/dsl/versions.json`.
- **Pre-Release Invariant**: Pre-release dialect (`0.1`) is edited in place; all readers, writers, and schemas update in sync without migration overhead.
- **Post-Release Migration**: No migration scaffold exists while the dialect is pre-release. When a second dialect ships, add explicit version steps at that point. Unrecognized dialect versions preserve their raw label while reading through the latest schema.

---

## 2. Codebase Organization & Modularity

The codebase enforces strict separation between pure logic and UI rendering:

```
fish/
├── src/
│   ├── core/                      # Pure business logic (Zero UI/DOM/React coupling)
│   │   ├── dsl/                   # Schema types, validators, additive normalization
│   │   ├── geometry/              # Matrix2D affine transforms, bounds, hit-testing, paths
│   │   ├── interactions/          # Pure operators: alignment, distribution, z-order, scaling
│   │   ├── compile.ts             # Auto-layout engine, drop-slot geometry, path converters
│   │   ├── data-bridge.ts         # Pristine capture, parsing, serialization, FSA save
│   │   └── id.ts                  # Replica-partitioned ID generator
│   ├── i18n/                      # Key-value localization modules (en.ts, index.ts)
│   ├── main.tsx                   # Preact workbench UI, canvas renderer, toolbar, panels
│   └── style.css                  # Tailwind entry
├── tests/                         # Vitest unit test suite (pure core logic tests only)
│   └── e2e/                       # Playwright browser E2E test suites
├── index.html                     # Vite build entry
├── vite.config.ts                 # Singlefile inliner, esbuild config, terser rules
├── tailwind.tokens.js             # Token values and their --fish-* CSS variables
└── tailwind.config.js             # Utilities mapped onto the token variables
```

---

## 3. Rendering Pipeline: DSL to SVG

```
[DesignDocument JSON]
        │
        ▼ (src/core/compile.ts: relayoutDocumentTree)
[Laid-out Elements]  <-- Auto-layout resolved, hugs/fills sized, local coordinates assigned
        │
        ▼ (src/ui/canvas/SvgElementRenderer.tsx)
[SVG Canvas Tree]    <-- Nested <g transform="translate(x, y)"> and derived instances
```

### 3.1 DSL & Scene Graph Model
- **Unified Local Coordinates**: All coordinates are parent-local. Frame children store `(x, y)` relative to parent container origin; `line`/`arrow` store delta endpoints `(dx, dy)`; `path.d` sits in a local `(0, 0, w, h)` box. Transforms compose naturally via SVG `<g transform="translate(el.x, el.y)">`.
- **Paint Stacks**: `fills[]` and `strokes[]` are ordered bottom-up. All fills render prior to strokes. Image fills (`type: "image"`) are paint-layer primitives rendered as `<pattern>` defs, not separate element nodes.
- **Layer Lock**: `locked: true` is materialized down subtrees. Enforced in the DOM via CSS `pointer-events: none` on `[data-locked]` so browser native hit-testing resolves occluded elements underneath.
- **Masking**: Emits `<mask id="mask_layer_<elId>">` sampling the raw fill stack. SVG's luminance mask defaults to alpha-mapping through an `feColorMatrix` filter adapter unless explicit luminance mode is set.
- **Shared Styles**: Elements store style links (`fillStyleId`, `strokeStyleId`, etc.) alongside evaluated local values (`fills`, `strokes`), allowing standalone SVG compilation without style indirection.

### 3.2 Containers, Components & Variants
- **Unified Container Model**: No separate `Group` primitive exists; `ContainerElement = FrameElement | ComponentElement | ComponentSetElement`.
- **Instance Resolution**: `InstanceElement` resolves derived IDs (`<instanceId>_<masterNodeId>`) and applies sparse `overrides`. Overrides are the single configuration channel for instances.
- **Component Sets & Variants**: `ComponentSetElement` acts as a bounding container for variants. The set defines `variantGroupProperties` (axes and allowed values), while individual component members carry their own `variantProperties` coordinates.

### 3.3 Layout & Geometry Engine
- **2-Pass Auto-Layout**: Pass 1 computes intrinsic hug dimensions bottom-up; Pass 2 assigns offsets and expands fill children top-down.
- **Structural Identity**: Relayout passes return original element references when dimensions and positions remain unchanged, preserving memoization across the tree.
- **Flow Escapes (`position: "absolute"`)**: Absolute elements and hidden children (`visible: false`) are skipped by auto-layout flow calculation and bound via container constraints instead.
- **Proportional Scaling**: The Scale tool calculates geometry proportionally against initial drag bounds via fractional anchors (`ScaleAnchor`), preserving relative arrangement across multi-selections.

### 3.4 SVG & Effects Rendering
- **SVG Stage**: Viewport pan and zoom are applied directly to the root SVG stage group (`[data-stage-transform]`).
- **Effect Split**:
  - `drop-shadow`, `inner-shadow`, and `layer-blur` compile into SVG filter chains in `CanvasDefs`.
  - `backdrop-blur` and `liquid-glass` compile into HTML elements with CSS `backdrop-filter` inside `<foreignObject>`, clipped to the element path.
- **Export Engine**: `core/export.ts` clones the SVG canvas, strips workbench chrome, resolves backdrop rasters via staged off-screen passes, and serializes to standalone SVG or PNG.

---

## 4. Performance & Frame Budget

To maintain a 60fps (16.7ms) interaction budget:
1. **Windowed Layer Tree**: The layer panel computes visible row geometry in a single O(n) pass, rendering only viewport rows (~30 elements) via spacers instead of the full DOM tree.
2. **Selective Memoization**: Component trees and SVG nodes sit behind strict memoization boundaries (`src/ui/memo.ts`). Geometry updates bypass layer panel re-renders.
3. **Subtree Culling**: Off-screen elements and defs are culled using unioned subtree bounding boxes (`subtreeBounds`).
4. **RAF Coalescing**: Pointer gestures coalesce mutations through `createRafCoalescer`, flushing at most one commit per frame.
5. **DOM-Independent Hit-Testing**: Caching parent origins and component indexes prevents repetitive tree walks during drag and snap operations.

---

## 5. UI Design Tokens & Theme

For the authoritative design system specification, design tokens, color palette, typography, radii, depth, motion, and visual guidelines, see [**`DESIGN.md`**](DESIGN.md).

All components consume tokenized workbench values from `tailwind.config.js`. UI styling strictly avoids ad-hoc hardcoded colors, sizes, or arbitrary styles.

Token values live in `tailwind.tokens.js` and are emitted as `--fish-*` CSS custom properties; `tailwind.config.js` maps utilities onto those variables. Flat colours are channel triplets so Tailwind's opacity modifiers keep working. Plugins can therefore reference the same variables without a rebuild when the theme changes; see `docs/PLUGINS.md` §3.3.

---

## 6. Internationalization (i18n)

All user-facing UI labels are strictly retrieved via `t("scope.key")` through `src/i18n/`.
- `src/i18n/en.ts` is the authored, nested dictionary; `src/i18n/index.ts` is the runtime.
- `scripts/vite-plugin-i18n-index.ts` flattens the dictionary into one front-coded key string plus a value array, and rewrites literal `t("scope.key")` calls to `t(slot)`. Only dynamic keys (`t(REFUSAL[key])`) still travel as strings, resolved lazily against the same table.
- Dev, tests and builds all read the same virtual table, so a key resolves identically in every mode.
- A locale only supplies the keys it translates; an omitted key keeps its English string. An unknown key still returns its path so a missing entry stays visible.
- Messages may use a compact ICU subset: `{arg}`, `{arg, plural, …}`, `{arg, select, …}`, `{arg, selectordinal, …}`, nested choices, exact `=N` plural cases and `#` for the count. `src/i18n/format.ts` parses such a message once and caches it; plain `{arg}` messages keep the single-regex path. Plural and ordinal categories come from `Intl.PluralRules` for the active locale, falling back to English.
- Dictionaries are structured key-value modules.
- New languages can be added by declaring a new locale module without altering UI components.

---

## 7. Build & Packaging Architecture

- **Single-File Bundler**: Bundled using `vite` and `vite-plugin-singlefile`.
- **Compression Pipeline**: `scripts/compress-shell.mjs` compresses the runtime JS/CSS blocks with Zopfli (`@gfx/zopfli`, a build-time devDependency only) into raw DEFLATE encoded in safe base86 ASCII (`fish/deflate-b86`). The stream is still RFC 1951, so the shipped inflate decoder is unaffected; the optimizer buys ~3% more than zlib level 9 for a few seconds of build time.
- **Synchronous Loader**: An inlined synchronous inflate decoder reconstitutes the runtime before mounting, ensuring zero-dependency, instant startup.
- **Clean Shell Invariant**: Saved documents retain packed runtime blocks without embedding live runtime state or unnecessary template markup.

---

## 8. External Agent & Headless Interfaces

External AI agents interact with FISH either by reading/writing the `#design-doc` JSON block or through the browser inspection bridge:

| Surface | Responsibility |
| :-- | :-- |
| `window.__fish` | Headless browser bridge: `doc`, `normalize(candidate)`, `validate()`, `check(options?)`, `measure(id)`, `measureAll()`, `layoutDebug()`, `exportCanvasPng()`, `exportCanvasSvg()`. |
| `core/measure.ts` | Provides canvas-space bounding boxes for elements and resolved instance subtrees without relying on DOM queries. |
| `core/cli/fish.ts` | CLI for running `check`, `apply`, and headless rendering/exporting outside the workbench UI. |
| `build-fish-agent-kit.mjs` | Assembles `dist/fish-agent-kit/` from its hand-written source `agent-kit/` (`SKILL.md` + `references/`), plus the compiled schema, CLI, and blank container. |
| `lib/skill-render.mjs` | Renders the one `SKILL.md` source twice: the archive copy (relative siblings) and the published page at `/skill.md` (absolute links plus the archive digest), and injects the app version and document dialect from their single sources. |

---

## 9. Import Pipelines

The import subsystem (`src/core/import/`) translates external formats into native FISH DSL:

- **HTML Import**: Measures source DOM in an isolated shadow container to capture computed layout boxes and converts CSS flow into absolute DSL structures. Rules in [`docs/lessons/import-export.md`](lessons/import-export.md).
- **Figma Import**: Maps Figma node JSON and asset bundles directly to DSL primitives and auto-layout attributes, verifying bounds against source frames. Rules in [`docs/lessons/import-export.md`](lessons/import-export.md).

---

## 10. Plugin Architecture (Micro-Kernel & Dynamic Bundles)

To protect the shell's strict single-file payload budget, extensible capabilities (e.g. AI background removal, icon search, third-party stock assets) run through a dynamic micro-kernel plugin architecture:

- **Host-Plugin Protocol (`PluginHostContext`)**: The host injects design-system components (`Button`, `SegmentedControl`), document state (`docRef`, `primarySelected`), snapshot commits (`commitSnapshot`), and viewport-aware coordinate placement (`dropTopLeft`) via [`src/core/plugins/plugin-contract.ts`](../src/core/plugins/plugin-contract.ts).
- **Zero-Dependency Single-Bundle Distribution**: Plugins are compiled into self-contained single-file ES modules with signed manifests (`plugin.json`).
- **Cryptographic Gate & Offline Persistence**: Bundles and model weights install from raw bytes verified via SHA-256 signatures, persisting into browser `IndexedDB` for offline-first instant boot.
- **Floating Workbench Sandbox**: Plugins run within a moveable floating frame (`FloatingPluginPanel.tsx`) with lifecycle isolation (`PluginBoundary.tsx`).

For complete development and authoring guidelines, see [`docs/PLUGINS.md`](PLUGINS.md), including §5 for the signing, installation, and verification chain.

