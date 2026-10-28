# FISH Plugin Architecture & Development Guide

This document defines the architecture of the FISH plugin system and provides a practical guide for authoring new built-in and remote hot-loaded plugins.

---

## 1. Architectural Philosophy & The Single-File Constraint

FISH is a **single-file self-executing vector design tool**: the editor shell, the design system and the runtime ship together in one HTML file that a designer opens from their desktop, and every kilobyte is downloaded and parsed before anything appears on screen.

In traditional desktop or web applications, expanding features often leads to monolithic bundle bloat. If background removal AI, icon finders, stock photo search, and code exporters were compiled directly into the core shell, that file would carry every feature's weight before the first frame.

To solve this, FISH implements a **Micro-Kernel + Plugin Architecture**:
1. **The Host Remains Lean**: The FISH core workbench handles canvas rendering, the vector DSL, geometry transforms, undo/redo, and persistence.
2. **Plugins Are Modular & Self-Contained**: Heavy functionality (AI models, external APIs, specialized asset search) is partitioned into modular plugins.
3. **Dependency Injection Over Hard Bundling**: The host provides design system components (`Button`, colors, typography) and document capabilities (`commitSnapshot`, `notify`) to plugins at runtime via `PluginHostContext`.
4. **Offline Resilience via IndexedDB**: AI model weights and plugin bundles downloaded from the cloud are persisted in the browser's IndexedDB, ensuring subsequent runs are instant and work 100% offline.

---

## 2. Core Contracts & Protocols

All plugins satisfy the contracts defined in [`src/core/plugins/plugin-contract.ts`](../src/core/plugins/plugin-contract.ts):

### 2.1 Two halves: `plugin.json` and the bundle

Every plugin is external; there is no registry of built-ins. A plugin is a directory
with **identity in data** and **behaviour in code**, and the two are joined at build
time into one signed file:

```json
// src/plugins/<id>/plugin.json — copied into the signed manifest, never imported
{ "id": "fish.icons", "name": "Icon Explorer", "description": "…", "category": "asset",
  "icon": "icons", "version": "1.0.0", "hostApi": "1",
  "width": 320, "height": 480, "resize": "vertical", "attribution": [ … ] }
```

```ts
// src/plugins/<id>/index.tsx — the only two exports a bundle may have
export const apiVersion = "1";
export function Component({ context }: { context: PluginHostContext }): JSX.Element
```

`PluginManifest` (the runtime shape, in `src/core/plugins/manifest.ts`) adds the two
fields the build computes: `sha256` of the code and `bytes`.

### 2.2 `PluginHostContext` (Dependency Injection)
Rather than plugins bundling their own buttons, inputs, or translations, the host injects standard services:

```ts
export interface PluginHostContext {
  ui: {
    /** The workbench's authoritative Button component (DESIGN.md compliant) */
    Button: typeof Button;
    /** Transparent checkerboard CSS background token */
    checkerboardStyle: Record<string, string>;
    /** Idempotent injection for CSS shipped inside the plugin bundle */
    injectStyles: (css: string) => void;
  };
  /** Live document reference */
  docRef: { current: DesignDocument };
  /** Currently selected primary element on the active page */
  primarySelected: DesignElement | null;
  /** Single-transaction document commit (integrates into Undo/Redo stack) */
  commitSnapshot: (doc: DesignDocument) => void;
  /** User-facing transient hint/toast message */
  notify: (msg: string) => void;
  /** Host locale identifier, e.g. "en", "zh" */
  locale: string;
  /**
   * Top-left of a `size` box at the centre of what the user can see through the
   * panels. Place an element the user did not aim at (a search-grid click)
   * through this — a plugin only ever holds page coordinates, and the point
   * those call "middle" is wherever the user last scrolled to, not where they
   * are looking.
   */
  dropTopLeft: (size: { width: number; height: number }) => { x: number; y: number };
}
```

### 2.3 The bundle: one file, no framework

A plugin bundle is a single ESM file. The shell is built with one P-256 public key
and **no list of plugins**, so a bundle cannot rely on anything being known about it
in advance — and it cannot resolve an import of its own.

| | |
| --- | --- |
| Identity | `src/plugins/<id>/plugin.json`, signed into the file at build time |
| Code | One ESM file in `dist-plugins/<id>/<version>/plugin.js`, installed at runtime |
| Runtime | `globalThis.__FISH_HOST__` only — a `blob:` module has no base URL |
| Ships with | `npm run plugin:build`; the shell knows only the public key |

Everything a bundle needs comes from `src/plugins/_host/index.ts`, which binds once
at module evaluation:

- `useState` / `useEffect` / … — the shell's hooks, so there is one Preact instance;
- `jsx` / `jsxs` / `Fragment` — the build aliases `preact/jsx-runtime` here;
- `getActivePage` / `updateActivePageElements` / `mapElements` / `firstImagePaint` / `createId` — the
  shell's own helpers, because where a page's tree lives and how ids are minted must
  not be copied. `mapElements` is the deep map: a nested selection is not a page child,
  so a plugin edits the tree with it rather than mapping the top level;
- `lucideProvider` / `remixProvider` / `openverseProvider` / `dragPayload` — the
  host-owned provider instances the canvas drop handler looks up by `providerId`;
- `insertRemoteImage` — the generic probe-and-link insert a plugin-owned image source
  uses for both the panel and a drag whose payload says `insert: "remote-image"`.
  The starting box is the source's decision: set `displayMaxDimension` on each
  result, or omit it to land at the file's natural size. The host applies it and
  never lets the element exceed its own `MAX_IMAGE_EDGE` (4096);
- `injectPluginStyles` — idempotent `<style>` injection for CSS shipped inside the bundle;
- UI components it does not own: `context.ui.Button`, `context.ui.SegmentedControl`.

A plugin-owned image source needs no host registry entry: keep search, result mapping
and the provider object in `src/plugins/<id>/`, take `insertRemoteImage` from `_host`
for insertion, and put `{ insert: "remote-image", result }` in drag payloads. The
host's generic path probes and links the file without knowing the source's id.

Anything else is a build error rather than a silent second copy of a framework:
`scripts/build-plugin.mjs` fails on any `preact` / `react` import. Glyphs (search,
spinner, scissors, …) are drawn from `src/plugins/_shared/glyphs.tsx` rather than
pulled from `lucide-react`, which would drag React in.

---

## 3. Design System & i18n Rules for Plugins

### 3.1 Design System Invariant
- **Never bundle custom button CSS or stock Tailwind colors**: Always consume `context.ui.Button` (`variant="primary"`, `variant="bar"`, etc.).
- **Typography**: Always use `font-sans` (`text-ui`, `text-displaySm`) for plugin dialogs and panels.
- **Theme Tokens**: Use only tokens defined in `DESIGN.md` (`bg-panel`, `bg-surface`, `bg-field`, `text-ink`, `text-ink-dim`, `border-rule`).

### 3.2 i18n Isolation Invariant
- **Never put plugin-specific strings into `src/i18n/en.ts`**. The host dictionary belongs only to the core workbench shell.
- Every plugin **must maintain its own self-contained translation dictionary** (e.g. `src/plugins/<name>/i18n.ts`).
- Plugins read `context.locale` to choose their display language and fall back to English gracefully.

### 3.3 Tokens Are CSS Variables
- Every colour, radius, shadow and motion token is emitted as a `--fish-*` custom property from `tailwind.tokens.js`; `tailwind.config.js` only maps utilities onto those variables.
- Flat colours are channel triplets (`--fish-panel: 24 24 24`) so `/NN` opacity utilities keep working. Translucent tokens (`brand-wash`, `selection*`, `swatch-ring`) are complete colours and do not take an opacity modifier.
- Consume the token utility or `var(--fish-…)`, never a copied hex. That is what lets a host theme change reach a plugin built earlier.
- Canvas palette colours are different: SVG presentation attributes cannot read `var()`, so they live in `src/ui/canvas/canvas-colors.ts` and are not part of the plugin CSS contract.

### 3.4 CSS Ownership (Current State)
- A plugin panel's content root carries `data-fish-plugin="<id>"`; scope custom selectors through it.
- Today the in-repo plugins rely on the shell's Tailwind build scanning `src/plugins`. That is a development convenience, not a contract: a plugin built outside this tree must ship its own CSS and inject it through `context.ui.injectStyles(css)` (or `injectPluginStyles` from `_host`).
- The planned external build compiles per-plugin CSS with an `fp-` utility prefix and inlines it into the signed bundle. Until that CLI exists, do not assume a new utility class in an external plugin exists in the host stylesheet.

---

## 4. Step-by-Step Guide: Creating a New Plugin

Here is how to create a self-contained plugin in 4 steps.

### Step 1: Create the Plugin Directory Structure
Under `src/plugins/<plugin-id>/`:
```
src/plugins/my-plugin/
├── i18n.ts              # Self-contained localization dictionary
├── MyPluginView.tsx     # Plugin user interface component
├── plugin.json          # Identity: id, name, version, size hints, attribution
└── index.tsx            # Behaviour: apiVersion + Component
```

### Step 2: Define Plugin Translations (`i18n.ts`)
```ts
// src/plugins/my-plugin/i18n.ts
export interface MyPluginStrings {
  title: string;
  action: string;
  hintSuccess: string;
}

const en: MyPluginStrings = {
  title: "My Quick Tool",
  action: "Run Action",
  hintSuccess: "Action completed successfully"
};

const zh: MyPluginStrings = {
  title: "我的快捷工具",
  action: "执行操作",
  hintSuccess: "操作已成功完成"
};

export function getStrings(locale: string = "en"): MyPluginStrings {
  return locale.startsWith("zh") ? zh : en;
}
```

### Step 3: Implement Plugin View (`MyPluginView.tsx`)
```tsx
// src/plugins/my-plugin/MyPluginView.tsx
import { useState } from "preact/hooks";
import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import { getStrings } from "./i18n";

export function MyPluginView({ context }: { context: PluginHostContext }) {
  const { ui, docRef, primarySelected, commitSnapshot, notify, locale } = context;
  const { Button } = ui;
  const strings = getStrings(locale);

  const [busy, setBusy] = useState(false);

  const handleAction = async () => {
    setBusy(true);
    // 1. Perform plugin logic (e.g., mutate elements or insert assets).
    //    An element the user did not aim at is positioned with
    //    `dropTopLeft({ width, height })`, never a hand-picked page coordinate.
    // 2. Commit transaction snapshot
    commitSnapshot({
      ...docRef.current,
      // updated elements / assets
    });
    notify(strings.hintSuccess);
    setBusy(false);
  };

  return (
    <div className="p-3 flex flex-col gap-3 font-sans">
      <div className="text-ui text-ink">
        {strings.title}
      </div>
      <Button
        variant="primary"
        size="field"
        block
        disabled={busy}
        onClick={handleAction}
      >
        {strings.action}
      </Button>
    </div>
  );
}
```

### Step 4: Ship it

Write identity to `plugin.json`, keep code in `index.tsx`, and build:

```json
// src/plugins/my-plugin/plugin.json
{ "id": "fish.my-plugin", "name": "My Quick Tool", "version": "1.0.0",
  "hostApi": "1", "category": "plugin", "icon": "sparkles",
  "description": "A demonstration tool for FISH" }
```
```bash
npm run plugin:build          # writes dist-plugins/fish.my-plugin/1.0.0/plugin.js, signed
```

The bundle must not import `preact` / `react` — take hooks and helpers from `../_host`.
`tests/plugin-isolation.test.ts` checks that nothing under `src/` outside `src/plugins/`
imports a plugin that has a `plugin.json`, that runtime imports outside a plugin reach
only `_host` / `_shared`, and that the built file is one self-contained module carrying
its signature.

If the panel ships CSS, pass it to `context.ui.injectStyles(css)` once (module
evaluation or first render). Inside a plugin built outside this tree, utility classes
are not guaranteed to exist in the host stylesheet; treat `--fish-*` variables as the
stable surface and keep plugin-specific selectors under `[data-fish-plugin="<id>"]`.

A plugin appears in the **Resources (Shift+I)** popover only **after** it is installed —
this build has no idea which plugins exist. The way in is "Load plugin file…": the
signature is checked against the built-in public key, and the manifest inside tells the
shell what it just installed. Right-clicking an installed row offers **Remove plugin**,
which drops the bundle from storage and closes the panel if it was showing. See
§5 below for the format and the trust chain.

---

## 5. Installation, Storage & Verification

- **One database per purpose.** Installed bundles live in `fish-plugins` (store
  `bundles`, keyPath `id`), never in `fish-autosave`: adding a store there would force
  a `DB_VERSION` bump, and an upgrade blocked by another tab is exactly the failure
  `backend.ts` documents.
- **Bytes, not URLs.** `fetch` fills the store; `openPlugin` re-hashes the stored bytes
  and executes them through `URL.createObjectURL`. Online, offline and "another file on
  this computer" are therefore the same path, and the check applies to what actually
  runs.
- **Single file, no bare specifiers.** A `blob:` module has no base URL, so a relative
  chunk or a bare `preact` import fails at panel open, not at build time. Both are
  guarded in the build and in `tests/plugin-isolation.test.ts`.
- **Crash containment.** `PluginBoundary` keeps a throwing plugin from unmounting the
  canvas.
- **Additive host surface.** `HOST_API_VERSION` is the major. Adding a bridge or context
  member keeps it; removing or changing one bumps it, and plugins targeting the old
  major are refused until rebuilt. Runtime code outside a plugin's own directory may
  only come from `../_host` or `../_shared`; `tests/plugin-isolation.test.ts` enforces it.

For untrusted third-party plugins, the panel can later host an
`<iframe sandbox="allow-scripts">` and speak the same surface over `postMessage`. The
serialisable part of `PluginHostContext` (`notify`, `locale`, `dropTopLeft`, document
get/commit) is what crosses that boundary; `ui.Button` and `docRef` cannot.
