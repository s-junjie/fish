# FISH Asset Sources

Use real media. A hand-drawn `<path>` is not a photograph, a portrait or a logo.

This file is the source table and the rules that apply to all of them. The DSL for image fills is in `dsl.md`; the command flow is in `workflow.md`.

---

## 1. Sources

| `--source` | Status | Credential | Best for | Output |
| :-- | :-- | :-- | :-- | :-- |
| `openverse` | CLI + UI | none | CC-licensed photography | remote URL, or bytes with `--embed` |
| `lucide` / `ri` | CLI + UI | none | 24×24 interface icons | inline path geometry |
| `wikimedia` | UI; CLI pending | none | architecture, places, encyclopedic subjects | remote URL, or bytes with `--embed` |
| `pixabay` | UI; CLI pending | `PIXABAY_API_KEY` | stock photography | `largeImageURL` (1280px) |

When a source is marked “CLI pending”, use the app's panel for it rather than inventing a command. The table is the single place to update when the CLI source lands.

Every result carries a `credit` the document stores as `{ name, url }`. Keep it: Openverse and Wikimedia results are licensed works, and Pixabay's terms expect attribution where the interface provides it.

### Visual & Editing Plugins (Workbench)

When styling or processing imagery on canvas, the workbench provides built-in visual plugins in the Resources panel:

| Plugin ID | Name | Role | Output |
| :-- | :-- | :-- | :-- |
| `fish.photo-fx` | Photo FX | Creative visual FX studio: halftone dots, analog film simulation, artistic stripes, glitch, mosaic, duotone tinting, and directional needle fades | Rendered PNG asset |
| `fish.cutout` | Background Remover | Client-side on-device AI subject cutout & transparency | Transparent PNG asset |

---

## 2. Search and place

Search is the fallback, not the first move: the material question belongs to the intake (`intake.md` §5), and `import` (§4) is how the user's own files get in. A source result can approximate a look; it cannot be the thing they meant. Search only when they have none or asked you to pick, and say what you picked.

```bash
./tools/fish assets search "modern workspace" --source openverse --limit 5
./tools/fish assets search "modern workspace" --source openverse --add-to design.fish.html --pick 0 --embed --to hero_rect
./tools/fish assets search "arrow-right" --source lucide --limit 3 --size 16
./tools/fish assets icon ./custom-mark.svg --size 16
```

- `--size N` (with `--source lucide|ri` or `assets icon`) scales the flattened `d` coordinates and proportional `stroke.width` cleanly to target px (`--stroke-width N` overrides it).
- `--limit N` caps results (the CLI caps at 20).
- `--pick N` chooses a result when writing to a document.
- `--add-to <doc>` writes the chosen asset into `doc.assets[]`.
- `--to <elementId>` binds an image fill to that element in the same run. Without it the asset is registered but nothing points at it.
- `--replace` swaps the image layers already on the target and drops assets nothing references. It needs `--to`, a single asset, and is not a batch mode.
- `--json` emits machine-readable results.

Registration is not placement. Without `--to`, bind the returned id yourself:

```json
"fills": [{ "type": "image", "assetId": "asset_123", "fit": "cover" }]
```

### Bring a URL you already chose

Already seen the right image — Unsplash, a press kit, an archive? Import its **file** URL, not the page:

```bash
./tools/fish assets import "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=2400&q=80" \
  design.fish.html --name Hero \
  --credit-name "Annie Spratt · Unsplash" \
  --credit-url "https://unsplash.com/photos/at-the-studio-Xyz123"
```

Fetched once and embedded like any local file, so nothing is hotlinked and `--strict-assets` passes. `--credit-name` and `--credit-url` go together, one source per run, and the credit is stored on the asset rather than painted — place the text yourself if the design has to show it.

Ask for the width you need (`?w=`), drop tracking parameters (`ixid`, `utm_*`), and keep the photo page in `--credit-url`. The licence is the source's, not the kit's: commercial use is fine on Unsplash and Pexels, reselling the image as-is is not.

---

## 3. Link or embed

A remote result is stored as a URL by default. The document is smaller, but it renders an empty box the moment it opens without that URL. A link keeps the original dimensions; the 4K cap applies to embedded bytes only.

`--embed` fetches the URL and writes the bytes into the document. The embedding path applies the app's image policy:

- the longest edge is capped at **4096px** (`MAX_IMAGE_EDGE`);
- the bytes are re-encoded as WebP;
- the result is a `data:` URI in `doc.assets[]`, so the file is self-contained.

Use `--embed` when the deliverable must open offline. Use a link when the source is expected to stay available and file size matters. When in doubt, embed. `assets import <url>` (§2) always embeds — that form exists for one specific image, not for a feed.

To convert links that are already in a document:

```bash
./tools/fish assets embed design.fish.html --all
```

This keeps each asset's id, so every fill that already points at it keeps working.

---

## 4. Local files

`assets import` is how a file on this machine enters a document that already exists:

```bash
./tools/fish assets import ./hero.jpg design.fish.html --name Hero --to hero_rect
```

Authoring a new document from JSON instead? An `assets[]` entry may declare `file:`, and `compose` inlines it (`dsl.md` § Fonts, Assets, Links & Slides), so a greenfield document carries its images from the first write.

`assets embed` re-fetches `asset.uri` over http(s), so it cannot read a path. A relative path fails as `ERR_INVALID_URL`; `file://` is not implemented.

Several files in one run only register them; place them with `apply`:

```bash
./tools/fish assets import ./a.jpg ./b.jpg ./c.jpg design.fish.html
```

---

## 5. Removing bytes nothing paints

Deleting a layer removes the paint, never the asset. `doc.assets[]` is a registry
and its bytes live in the file whether or not anything points at them, so a
photograph taken out of a product card is still a 500KB photograph.

```bash
./tools/fish assets prune design.fish.html
```

Drops every asset no paint references, using the same scan the layer panel counts
from — a paint held by a style or by an instance override keeps its bytes. It
prints each id it removed with the bytes freed. `check` reports the same set as
`info`, with the size, so the number is visible before you decide.

---

## 6. Credentials

Pixabay is the only source that needs a key.

- **CLI (when it lands):** read `PIXABAY_API_KEY` from the environment. Never write the key into a document, a command in the repo, or a skill file.
- **App plugin:** the key is stored locally in `localStorage["fish.pixabay.api-key"]`. It is not sent anywhere except Pixabay's API, but a local-file page or another plugin on the same origin can read it. Treat it as a quota credential, not a secret.

If a key is rejected, stop and ask the user for a valid one. Do not retry in a loop.

---

## 7. Final gate

```bash
./tools/fish check design.fish.html --strict-assets
```

This turns any asset still left as a URL into an error. It also raises a font family with no `fonts[].src` from a note to a warning, because a bare family name re-wraps on a machine that lacks it. A face that is meant to come from the machine is not an asset to embed: declare it with a generic fallback (`"PingFang SC, sans-serif"`) and the warning is satisfied.
