// `vitest/config` re-exports Vite's defineConfig with the `test` block typed —
// plain `vite` rejects it, and tsconfig only covers src/ + tests/, so the error
// surfaces in the editor rather than in `npm run typecheck`.
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { lucideCompactPlugin } from "./scripts/vite-plugin-lucide-compact";
import { i18nIndexPlugin } from "./scripts/vite-plugin-i18n-index";
import { coverBlockHtml, insertCoverBlock } from "./src/core/cover-block";
import { buildDefaultCover } from "./src/ui/default-cover";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_COVER = buildDefaultCover();

const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"));

// The update endpoint is two values and nothing else: where the manifest lives,
// and the P-256 public key that signed it. Both come from the environment so a
// build with no release endpoint needs no edit to this file — it ships with the
// feature off, which is the honest state of a project that has not published one
// yet. `FISH_UPDATE_PUBLIC_KEY` is a JWK as JSON; `scripts/write-release-manifest.mjs`
// prints the matching public key for it.
const updateManifestUrl = process.env.FISH_UPDATE_MANIFEST_URL ?? "";
const updatePublicKey = process.env.FISH_UPDATE_PUBLIC_KEY ?? "";

/**
 * The plugin trust anchor: one P-256 public key, nothing else.
 *
 * `scripts/build-plugin.mjs` mints the keypair into `.fish-plugin-key.json`
 * (gitignored) the first time it runs, and that file supplies the public half here
 * so a local build can install the plugins it just built. A release sets
 * `FISH_PLUGIN_PRIVATE_KEY` and the public half is derived from it, so the shell
 * cannot end up trusting a different key from the one that signed the bundles.
 * With neither, the key is empty and the shell refuses every plugin rather than
 * accepting one it cannot verify.
 */
function pluginKeyFromEnv(): string {
  const raw = process.env.FISH_PLUGIN_PRIVATE_KEY;
  if (!raw) return "";
  let parsed: { privateKey?: JsonWebKey; publicKey?: JsonWebKey };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FISH_PLUGIN_PRIVATE_KEY is not valid JSON");
  }
  const publicKey =
    parsed?.publicKey ??
    crypto.createPublicKey({ key: parsed?.privateKey ?? (parsed as unknown as JsonWebKey), format: "jwk" }).export({ format: "jwk" });
  return JSON.stringify(publicKey);
}

const pluginPublicKey =
  process.env.FISH_PLUGIN_PUBLIC_KEY ??
  (() => {
    const fromEnv = pluginKeyFromEnv();
    if (fromEnv) return fromEnv;
    const keyFile = path.resolve(process.cwd(), ".fish-plugin-key.json");
    if (!fs.existsSync(keyFile)) return "";
    try {
      return JSON.stringify(JSON.parse(fs.readFileSync(keyFile, "utf-8")).publicKey ?? "");
    } catch {
      return "";
    }
  })();

// The document dialect is single-sourced in src/core/dsl/versions.json; index.html
// carries the placeholder so the showcase document cannot drift from it.
const docVersions = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "src/core/dsl/versions.json"), "utf-8")
);


const DOC_BLOCK_RE = /(<script\s+id=["']design-doc["'][^>]*>)[\s\S]*?(<\/script>)/i;
// Bitmaps live in their own block (see data-bridge.ts) so the element tree stays
// readable. The blank shell must not carry them — a single inline image is most
// of the document's bytes, and an empty file has no use for it. The source
// `index.html` keeps the case document; only the built shell drops it.
const ASSETS_BLOCK_RE = /<script\s+id=["']fish-assets["'][^>]*>[\s\S]*?<\/script>/i;
// What is measured here is the vite output, and scripts/compress-shell.mjs
// rewrites that same file afterwards; the size it ends up at is printed by the
// step that writes it, which is the only place a number about it would be true.

export default defineConfig({
  define: {
    __FISH_APP_VERSION__: JSON.stringify(pkg.version),
    __FISH_UPDATE_MANIFEST_URL__: JSON.stringify(updateManifestUrl),
    __FISH_UPDATE_PUBLIC_KEY__: JSON.stringify(updatePublicKey),
    __FISH_PLUGIN_PUBLIC_KEY__: JSON.stringify(pluginPublicKey)
  },
  plugins: [
    i18nIndexPlugin(),
    lucideCompactPlugin(),
    preact(),
    viteSingleFile({
      useRecommendedBuildConfig: true,
      removeViteModuleLoader: true
    }),
    {
      name: "fish-version-stamp",
      transformIndexHtml(html) {
        return html
          .replaceAll("__FISH_APP_VERSION__", pkg.version)
          .replaceAll("__FISH_DOC_VERSION__", docVersions.current);
      }
    },
    {
      name: "clean-inlined-css",
      enforce: "post",
      transformIndexHtml(html) {
        return html
          .replaceAll("-webkit-appearance:button", "-webkit-appearance:button;appearance:button")
          .replaceAll("-webkit-appearance:textfield", "-webkit-appearance:textfield;appearance:textfield")
          .replaceAll("display:block;vertical-align:middle", "display:block");
      }
    },
    {
      name: "fish-shell-split",
      apply: "build",
      enforce: "post",
      // vite-plugin-singlefile inlines the bundle in generateBundle, so the split
      // has to happen there too — a transformIndexHtml hook would still see the
      // pre-inline template.
      generateBundle(_options, bundle) {
        for (const [name, chunk] of Object.entries(bundle)) {
          if (chunk.type !== "asset" || !name.endsWith(".html")) continue;
          const source = String(chunk.source);
          if (!DOC_BLOCK_RE.test(source)) {
            this.error(`${name} has no #design-doc block — the build template must keep the case document`);
            return;
          }
          // The shell is the empty fish: drop the case document's bitmaps, which
          // barely compress and are the bulk of an empty file's bytes. The
          // design-doc block is blanked (not removed) so re-saves anchor on it;
          // fish-assets is removed entirely because an empty asset block is pure
          // noise (serializeSelf omits it too).
          const shell = source.replace(DOC_BLOCK_RE, "$1$2").replace(ASSETS_BLOCK_RE, "");
          // The default cover ships inside the shell, not only in the save path:
          // every file starts as a copy of this shell — `blank.fish.html` in the
          // agent kit, a new document, a CLI compose — and none of those go
          // through `serializeSelf` before someone looks at the file. A save
          // replaces this block with the document's own cover.
          chunk.source = insertCoverBlock(shell, coverBlockHtml(DEFAULT_COVER.svg, DEFAULT_COVER.background));
        }
      }
    },
    {
      name: "fish-dev-standalone-server",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/__fish_bundle__" || req.url === "/__fish_bundle__.html") {
            const distFile = path.resolve(process.cwd(), "dist/index.html");
            if (fs.existsSync(distFile)) {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(fs.readFileSync(distFile, "utf-8"));
              return;
            }
          }
          next();
        });
      }
    }
  ],
  esbuild: {
    legalComments: "none"
  },
  build: {
    target: "es2020",
    // terser over esbuild: ~7 KB smaller on this bundle. `drop_console` must stay
    // off — `main.tsx` reports document validation through console.warn/error.
    minify: "terser",

    terserOptions: {
      ecma: 2020,
      toplevel: true,
      compress: {
        ecma: 2020,
        passes: 3,
        toplevel: true,
        pure_getters: true,
        unsafe_arrows: true
      },
      mangle: { toplevel: true },
      format: { comments: false, ecma: 2020 }
    },
    cssMinify: true,
    outDir: "dist",
    emptyOutDir: true
  },
  test: {
    // Resets the module-level singletons (`heldMasters`, the text-measure cache
    // and its injected measurer) after every test: with shared modules, a
    // measurer or a held component definition outlives the file that installed
    // it. See the header of `tests/setup.ts`.
    setupFiles: ["tests/setup.ts"],
    // Modules are shared between test FILES, which is what keeps the suite at
    // ~45 s. The price is that a module's state outlives the file that built it,
    // so a failing case can move to a different file when the file set changes —
    // see `npm run test:isolated`, which is the run to trust when a red does not
    // reproduce on the file named. Two hook mocks that leaked this way
    // (`shadow-spread`, `effect-stack-order`) now unmock themselves in afterAll.
    isolate: false,
    // The default 5s is a budget for a unit test, not for the source-scanning
    // rigs: `version-consistency` reads all of `src/ui`, and under a full
    // parallel run the filesystem is the bottleneck, so it times out with a
    // different test failing each time. A red that flips which case it lands on
    // is worse than a slow suite — it makes "all green" meaningless exactly when
    // a structural change needs it to mean something.
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/e2e/**", "**/scratch/**", "scratch/**"]
  }
});
