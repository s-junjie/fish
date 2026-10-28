import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import versions from "../src/core/dsl/versions.json";
import schema from "../src/core/dsl/fish.schema.json";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import { OVERRIDABLE_PROPERTIES } from "../src/core/dsl/types";
import { normalizeDesignDocument, CANONICAL_KEYS } from "../src/core/dsl/normalize";
import { canonicalKey, camelCase, FIT_ALIASES } from "../src/core/dsl/normalize/shared";
import { ADJUST_KEYS } from "../src/core/dsl/color-filter";
import { en } from "../src/i18n";
import { LAYOUT_KEYS, GRID_ONLY_LAYOUT_KEYS, FLEX_ONLY_LAYOUT_KEYS } from "../src/core/dsl/normalize/auto-layout";
import { createEmptyDocument } from "../src/core/data-bridge";
import { APP_VERSION } from "../src/core/version";
import {
  ELEMENT_TYPES,
  AUTO_LAYOUT_MODES,
  AUTO_LAYOUT_DIRECTIONS,
  PAINT_TYPES,
  EFFECT_TYPES,
  WIDTH_SIZING_MODES,
  MASK_MODES,
  BLEND_MODES,
} from "../src/core/dsl/schema-enums";

/**
 * Every place that writes the document dialect must agree with
 * `src/core/dsl/versions.json`. Adding a writer without adding it here is how
 * the version drifts back into being defined in six places.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf-8");
const DSL_DOC = "agent-kit/references/dsl.md";
const docBlock = (html: string) =>
  /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1] ?? "";


describe("the document dialect has one source", () => {
  it("derives the reader constant from versions.json", () => {
    expect(LATEST_DOCUMENT_VERSION).toBe(versions.current);
  });

  it("keeps the bundled JSON schema on the current dialect", () => {
    expect(schema.properties.version.enum).toEqual([versions.current]);
  });

  /**
   * A duplicate JSON key is not a syntax error: every standards-compliant parser
   * keeps the last occurrence and drops the rest, silently. `Paint` carried two
   * `angle` keys — the linear gradient's and the radial ellipse rotation's — so
   * `json.load` here had always been reading the radial description, and a
   * hand-edited schema kept whichever an editor happened to write last.
   *
   * `JSON.parse` cannot see this, because it has already thrown the first
   * occurrence away by the time any assertion could look. Scanning the raw text
   * for a key appearing twice inside one object is the only place it is visible.
   */
  it("declares no duplicate key, which JSON would silently resolve to the last", () => {
    const raw = read("src/core/dsl/fish.schema.json");

    /**
     * A duplicate key is not a syntax error. Every standards-compliant parser
     * keeps the last occurrence and drops the rest without a word, and the
     * `object_hook` a reviver receives has already lost the first one — so this
     * cannot be checked against the parsed value at all. `Paint` carried two
     * `angle` keys (the linear gradient's angle and the radial ellipse rotation),
     * which means the linear gradient was documented by the radial one for as long
     * as the file existed, and a hand edit depended on which spelling an editor
     * happened to write last.
     *
     * So: track object nesting in the text and look for a key repeated inside one
     * object. A key recurring across SIBLING objects is normal (`type`, `name`,
     * `description`) and is not what this is about.
     */
    const report: string[] = [];
    const stack: Array<{ keys: Set<string>; path: string }> = [];
    const tokens = /"(?:[^"\\]|\\.)*"\s*:|[{}\[\]]/g;
    let path: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = tokens.exec(raw))) {
      const tok = m[0];
      if (tok === "{" || tok === "[") {
        stack.push({ keys: new Set(), path: path.join("/") });
        path = [...path, "[]"];
      } else if (tok === "}" || tok === "]") {
        stack.pop();
        path = path.slice(0, -1);
      } else {
        const key = JSON.parse(tok.slice(0, tok.lastIndexOf(":"))) as string;
        const frame = stack[stack.length - 1];
        if (frame) {
          if (frame.keys.has(key)) report.push(`${frame.path || "<root>"}: "${key}" declared twice`);
          frame.keys.add(key);
        }
      }
    }
    expect(report, report.join("; ")).toEqual([]);
  });

  // The schema JSON must never enter the runtime bundle; the runtime reads
  // schema-enums.ts instead, and this assertion is what keeps that copy honest.
  it("keeps the runtime enum copy in step with fish.schema.json", () => {
    const defs = schema.definitions;
    expect([...ELEMENT_TYPES]).toEqual(defs.DesignElement.properties.type.enum);
    expect([...AUTO_LAYOUT_MODES]).toEqual(defs.AutoLayout.properties.mode.enum);
    expect([...AUTO_LAYOUT_DIRECTIONS]).toEqual(defs.AutoLayout.properties.direction.enum);
    expect([...PAINT_TYPES]).toEqual(defs.Paint.properties.type.enum);
    expect([...EFFECT_TYPES]).toEqual(defs.Effect.properties.type.enum);
    expect([...WIDTH_SIZING_MODES]).toEqual(defs.ElementSizing.properties.width.enum);
    expect([...MASK_MODES]).toEqual(defs.MaskMode.enum);
    expect([...BLEND_MODES]).toEqual(defs.BlendMode.enum);
  });

  /**
   * The schema is the contract an external author reads, and the normalizer
   * accepts both a top-level `width` mode and the compact `sizing` string. A
   * schema that publishes only the canonical object form sends generators to a
   * number-and-`px` workaround the engine never asked for.
   */
  it("publishes the input spellings the normalizer accepts", () => {
    const width = (schema.definitions.DesignElement.properties as any).width;
    const widths = width.oneOf.find((branch: any) => Array.isArray(branch.enum))?.enum ?? [];
    expect(widths).toEqual([...WIDTH_SIZING_MODES]);
    const sizing = (schema.definitions.DesignElement.properties as any).sizing;
    expect(sizing.oneOf.some((branch: any) => branch.type === "string")).toBe(true);
  });

  it("keeps the showcase document's version a build-time substitution", () => {
    expect(docBlock(read("index.html"))).toContain('"version": "__FISH_DOC_VERSION__"');
    expect(read("vite.config.ts")).toContain("__FISH_DOC_VERSION__");
  });

  /**
   * The in-app Figma importer is a second writer of a document, and a writer that
   * never spells the dialect out is the whole rule: it emits PAGES, and the
   * document it commits carries the version the app already had. A dialect spelled
   * here would be a dialect the app's own `normalize` had to undo.
   */
  it("keeps the in-app Figma importer free of a hardcoded dialect", () => {
    const importer = read("src/core/import/figma-import.ts");
    expect(importer).not.toMatch(/version:\s*["']0\./);
    expect(importer).not.toMatch(/LATEST_DOCUMENT_VERSION|versions\.json/);
    // It produces pages and elements only; the document is the caller's.
    expect(importer).toContain("pages,");
    expect(importer).toContain("elements,");
  });

  it("stamps a new document with the current dialect", () => {
    expect(createEmptyDocument().version).toBe(LATEST_DOCUMENT_VERSION);
  });

  /**
   * The other version axis: the app's, which lives in `package.json` and is
   * stamped into the shell at build time. Nothing is allowed to spell it out —
   * a build that answered `0.0.1` while the published shell said `1.4.0` would
   * offer every user a downgrade dressed as an update.
   */
  describe("the app version has one source", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };

    it("stamps the shell from package.json", () => {
      const config = read("vite.config.ts");
      expect(config).toContain("__FISH_APP_VERSION__: JSON.stringify(pkg.version)");
      expect(APP_VERSION).toBe(pkg.version);
    });

    it("has the release manifest claim that same version", () => {
      // A writer of a version claim is a writer of a version. Registered here
      // so a second one cannot appear without this noticing.
      const writer = read("scripts/write-release-manifest.mjs");
      expect(writer).toContain('path.resolve(process.cwd(), "package.json")');
      expect(writer).toMatch(/version:\s*pkg\.version/);
      expect(writer).not.toMatch(/version:\s*"[0-9]+\.[0-9]+/);
    });

    it("makes the update path compare against the stamped version, not a literal", () => {
      expect(read("src/core/update/check.ts")).toContain("isNewer(release.version, APP_VERSION)");
      expect(read("src/core/update/check.ts")).not.toMatch(/APP_VERSION\s*[,)]?\s*$/m);
    });
  });

  // dsl.md is read by external authors, not by the runtime, so it cannot
  // consume the constant — it is asserted instead, in both what it must say
  // (the dialect it describes) and what it must not (the superseded claim).
  it("keeps dsl.md describing the current dialect", () => {
    const skill = read(DSL_DOC);
    expect(skill).toContain(`"version": "${versions.current}"`);
    expect(skill).toContain("Local Coordinate Convention");
    expect(skill).not.toContain("canvas absolute");
  });

  // The blend vocabulary is the one enum dsl.md writes out by hand, and an
  // external author reads THAT list — `plus-lighter` shipped in the engine while
  // the doc still offered sixteen modes, so the mode an Figma `LINEAR_DODGE`
  // maps to was invisible to the only audience that writes documents by hand.
  it("keeps dsl.md's blend vocabulary in step with the engine's", () => {
    const line = read(DSL_DOC)
      .split("\n")
      .find((l) => l.includes("**Blend mode**"));
    expect(line, "dsl.md states the blend vocabulary").toBeTruthy();
    for (const mode of BLEND_MODES) {
      expect(line!, `${mode} is a published blend mode`).toContain(`\`${mode}\``);
    }
  });

  it("reads a document at the current version without relabelling it", () => {
    const res = normalizeDesignDocument({ version: versions.current, elements: [] });
    expect(res.document.version).toBe(versions.current);
  });

  // Both checks below read the built shell, and `dist/` is gitignored: on a clean
  // clone there is no artifact, so they would fail on ENOENT before saying
  // anything about the dialect. `npm run verify` builds first; `npm test` alone
  // must not depend on that ordering.
  describe.skipIf(!fs.existsSync(path.join(root, "dist/index.html")))("the built shell", () => {
    // The loader rebuilds the runtime before the parser leaves <body>. If it stopped
    // being the last thing in the document, every file would open blank, and no unit
    // test that reads the HTML would notice.
    it("keeps the loader last, so the app mounts before the first paint", () => {
      const shell = read("dist/index.html");
      const bodyClose = shell.lastIndexOf("</body>");
      const loader = shell.lastIndexOf("<script>", bodyClose);
      expect(loader, "no inline loader before </body>").toBeGreaterThan(0);
      const app = shell.indexOf('<div id="app">');
      expect(app, "no mount point before the loader").toBeGreaterThan(-1);
      expect(app, "the loader runs before #app exists").toBeLessThan(loader);
      expect(shell.indexOf('type="fish/deflate-b86"'), "the payloads live with the loader").toBeLessThan(loader);
      expect(shell, "the runtime is still inline").not.toContain('<script type="module"');
    });

    // dsl.md tells an external author which blocks are theirs and which are the
    // runtime. Naming a block the file does not have sends them to edit the engine.
    it("names in dsl.md only the blocks the shell actually carries", () => {
      const skill = read(DSL_DOC);
      const shell = read("dist/index.html");
      for (const id of ["design-doc", "fish-rt-css", "fish-rt"]) {
        expect(skill, `dsl.md does not mention #${id}`).toContain(`#${id}`);
        expect(shell, `the shell has no #${id}`).toContain(`id="${id}"`);
      }
    });
  });
});

/**
 * The runtime never bundles `fish.schema.json` (~16KB), so every vocabulary the
 * engine actually reads is a hand-written copy of it. Each copy needs its own
 * assertion or it drifts in silence, and the drift is always *deletion*: the
 * overridable list carried 18 entries on the write side and 14 on the read side,
 * so the four style bindings were written as overrides and dropped on the next
 * load, with no repair and no way for the user to tell.
 *
 * Membership is what matters, not order.
 */
describe("hand-written schema copies stay in step", () => {
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    expect([...a].sort()).toEqual([...b].sort());

  it("keeps the overridable property list in step with fish.schema.json", () => {
    const schemaList =
      schema.definitions.DesignElement.properties.overrides.items.properties.property.enum;
    sameSet(OVERRIDABLE_PROPERTIES, schemaList);
  });

  /**
   * `CANONICAL_KEYS` is the answer to "does the engine read this key at all",
   * and `fish.schema.json` is the copy an external author is handed. A key the
   * vocabulary reads and the schema does not declare is invisible to the author
   * it exists for; a key the schema declares that nothing reads is a silent
   * no-op that still saves and still round-trips. The two must therefore be the
   * SAME SET — measured through the camel/kebab closure, because both spellings
   * are accepted and the schema publishes everything an author may write.
   * Case-folded variants are the gate's tolerance layer and are not published.
   */
  it("declares exactly the element keys the vocabulary reads, in both spellings", () => {
    for (const key of CANONICAL_KEYS) {
      // The one rule the closure must not grow: a snake_case key is refused by
      // name (`isKnownElementKey`), so it has no spelling twin to publish — and
      // `canonicalKey` would fold its underscores away into one anyway. None
      // are listed today; this is the guard for the first one that tries.
      expect(key.includes("_"), `snake_case key listed: ${key}`).toBe(false);
    }
    const closure = new Set<string>();
    for (const key of CANONICAL_KEYS) {
      closure.add(key);
      closure.add(canonicalKey(key));
      closure.add(camelCase(key));
    }
    sameSet([...closure], Object.keys(schema.definitions.DesignElement.properties));
  });

  // The element-level `fit` enum sat at three values while `FIT_ALIASES`
  // resolved `crop` and Paint.fit declared it: the one spelling a writer reaches
  // for when the image focal-crops was refused at the door this file guards.
  it("keeps both fit enums in step with what FIT_ALIASES resolves", () => {
    const resolved = [...new Set(Object.values(FIT_ALIASES))].sort();
    sameSet(schema.definitions.DesignElement.properties.fit.enum, resolved);
    sameSet(schema.definitions.Paint.properties.fit.enum, resolved);
  });

  /**
   * The colour axes are the other list `dsl.md` writes out by hand, and the one
   * nothing graded.
   *
   * `brightness` sat in three places at once — a `ColorFilter` field whose gain
   * the renderer folded into `exposure`'s, a property in `fish.schema.json`, and
   * a line of `dsl.md` — while no slider could reach it and no test compared
   * the three. `ADJUST_AXES` is the list the panel is built from, so an axis on
   * it has a control, a label and a home in the document, and an axis off it does
   * not exist. Grading all four surfaces against that one list is what turns the
   * next orphan red instead of shipping it.
   */
  it("keeps the colour axes in step across the engine, the schema, the doc and the panel", () => {
    sameSet(ADJUST_KEYS, Object.keys(schema.definitions.ColorFilter.properties));
    for (const key of ADJUST_KEYS) {
      expect(en.adjust[key], `${key} needs a slider label`).toBeTruthy();
    }

    const lines = read(DSL_DOC).split("\n");
    const start = lines.findIndex((l) => l.includes("**Color filter**"));
    const block: string[] = [];
    for (let i = start; i < lines.length && (i === start || !/^- \*\*/.test(lines[i])); i++) {
      block.push(lines[i]);
    }
    for (const key of ADJUST_KEYS) {
      expect(block.join("\n"), `dsl.md names ${key}`).toContain(`\`${key}\``);
    }
  });

  // A layer filter is read on an image layer and nowhere else, so the schema has
  // to say so: it is the copy an external author reads, and a description that
  // omits the restriction is how "accepted, saved, never applied" gets written.
  it("states on the layer adjust that only an image layer reads it", () => {
    expect(schema.definitions.Paint.properties.adjust.description).toMatch(/image layer only/i);
  });

  // The claim outlived its subject: "The agent and the critique both honour it"
  // was written in the same commit that added the fields, and the critique was
  // gone five hours later; the sentence shipped to every external author anyway,
  // naming a component that no longer existed.
  it("keeps dsl.md from promising anything to a component that is gone", () => {
    expect(read(DSL_DOC)).not.toMatch(/the critique/);
  });

  /**
   * `dsl.md` told every external author that `fonts` was decorative — "the
   * renderer does not read it, no `@font-face` is injected from it" — while
   * `exportCanvasSvg` has been emitting an `@font-face` per entry that has a
   * `family` and a `src` (`core/export-defs.ts`, `injectFontFaces`). That is not
   * a harmless error: it told authors to leave `src` off, which is exactly the
   * case where the export cannot do anything and a recipient without the font
   * gets a fallback stack and reflowed text.
   *
   * The two halves really do differ, which is why the prose was rewritten rather
   * than the feature removed: the canvas resolves `style.fontFamily` against the
   * machine's own fonts and must not inject anything, while the exported file is
   * the artifact that travels. So the assertion is on the surviving claim.
   */
  it("does not tell authors that fonts[] is inert when the export honours it", () => {
    const skill = read(DSL_DOC);
    // Scoped to the whole-array claim, not to "does not read it" in general: the
    // corrected prose still says the CANVAS does not read it, and that half is
    // true — the canvas must not inject anything, it shares the machine's fonts.
    expect(skill).not.toMatch(/renderer does not read it/);
    expect(skill).not.toMatch(/no `@font-face` is injected from it/);
    expect(skill).toMatch(/exportCanvasSvg`? emits an `@font-face`/);
    // And the claim is true, not just written down.
    expect(read("src/core/export-defs.ts")).toMatch(/export function injectFontFaces/);
    expect(read("src/core/export.ts")).toMatch(/injectFontFaces\(clone, doc\)/);
  });

  /**
   * `AssetRef.credit` was written by both photo providers and read by the assets
   * panel while the shipped schema stopped at `palette`. The schema is the
   * canonical copy the agent kit hands to an external author, so the gap was a
   * claim that the engine stores something it does not declare.
   *
   * The list is exact on purpose. It went the other way too: `description`,
   * `visualDna`, `palette` and `tags` were declared here and read by nothing —
   * the first three for an asset pipeline that never shipped, `tags` by a search
   * filter that no writer could ever feed. An author was told four fields that
   * round-tripped, saved, and did nothing.
   */
  it("declares exactly the AssetRef fields the engine stores", () => {
    expect(Object.keys(schema.definitions.AssetRef.properties).sort()).toEqual(
      ["credit", "duration", "height", "id", "name", "uri", "width"].sort()
    );
  });

  it("knows every layout key the schema declares", () => {
    // An unrecognised key is reported as unknown and dropped. The schema's own
    // keys must never be in that set.
    for (const key of Object.keys(schema.definitions.AutoLayout.properties)) {
      expect(LAYOUT_KEYS.has(key), `layout key not recognised: ${key}`).toBe(true);
    }
  });

  it("keeps the grid-only and flex-only layout keys apart", () => {
    // A key in both lists would be dropped on every mode switch, which reads as
    // the control silently refusing the edit.
    for (const key of GRID_ONLY_LAYOUT_KEYS) {
      expect(FLEX_ONLY_LAYOUT_KEYS.includes(key), `in both lists: ${key}`).toBe(false);
      expect(LAYOUT_KEYS.has(key), `not a recognised layout key: ${key}`).toBe(true);
    }
    for (const key of FLEX_ONLY_LAYOUT_KEYS) {
      expect(LAYOUT_KEYS.has(key), `not a recognised layout key: ${key}`).toBe(true);
    }
  });

  it("names every element type the DSL declares, and keeps its own type", () => {
    // The first of the silent failures a new element type meets: a type the
    // normalizer does not recognise is defaulted to `rect` (or inferred from its
    // keys), and the element survives as an empty box with a repair nobody reads.
    for (const type of ELEMENT_TYPES) {
      const { document, repairs } = normalizeDesignDocument({
        version: versions.current,
        canvas: { width: 400, height: 300, unit: "px" },
        elements: [{ id: `e_${type}`, type }]
      } as never);
      const el = getActivePage(document).children[0] as { type?: string } | undefined;
      expect(el?.type, `"${type}" did not survive normalization`).toBe(type);
      expect(
        repairs.filter((r) => r.kind === "type"),
        `"${type}" needed a type repair`
      ).toEqual([]);
    }
  });

  // dsl.md is what an external author reads, and prose has no compiler. A
  // stale sentence there is not a documentation defect — it changes what gets
  // built. It claimed image fills paint nothing while the renderer painted them,
  // so authors avoided a capability the engine had and reached for a legacy
  // element type instead.
  describe("dsl.md", () => {
    const skill = read(DSL_DOC);
    const section = (title: string) => {
      const start = skill.indexOf(`## ${title}`);
      expect(start, `missing section: ${title}`).toBeGreaterThan(-1);
      const rest = skill.slice(start + 1);
      const end = rest.indexOf("\n## ");
      return end === -1 ? rest : rest.slice(0, end);
    };

    it("documents exactly the element types the DSL has", () => {
      // The character class takes capitals because the vocabulary is not
      // uniformly lower-case: `componentSet` is the one camelCase entry, and a
      // `[a-z-]` class silently drops it from BOTH sides of the comparison — which
      // is how a hand-edited dsl.md can drift without this test noticing.
      const rows = [
        ...section("Element Primitives").matchAll(/^\| `([a-zA-Z-]+)` \|(?! *Payload keys)/gm)
      ].map((m) => m[1]);
      sameSet(rows, ELEMENT_TYPES);
    });

    it("describes an image as a fill, not as an element type", () => {
      // `image` is a PAINT type, not an element type, so its absence from the
      // Element Primitives table is the table being right and not being short.
      // The two halves are asserted together because the failure this guards is a
      // reader concluding the table is incomplete and inventing a `type: "image"`.
      expect(skill).toMatch(/image is a \*\*fill layer\*\*/);
      expect(skill).not.toMatch(/image fill renders as nothing/);
      expect(ELEMENT_TYPES as readonly string[]).not.toContain("image");
      expect(PAINT_TYPES as readonly string[]).toContain("image");
    });

    it("does not still call space-evenly unsupported now that flex implements it", () => {
      // The same fact lives in two places — §5's justify enum and this
      // "what CSS has and this dialect does not" list — and the enum was
      // extended while this copy was not. Two copies of a fact is how one of
      // them goes stale; the assertion is that they agree.
      const start = skill.indexOf("### What CSS has and this dialect does not");
      expect(start, "missing the unsupported-CSS section").toBeGreaterThan(-1);
      const list = skill.slice(start, skill.indexOf("### What this dialect has", start));
      expect(list, "flex has space-evenly now").not.toContain("space-evenly");
      expect(list, "align-self is still absent").toContain("align-self");
    });

    it("states the same overridable property list as the engine", () => {
      // Anchored on the `overrides[].property` sentence, which is the one that
      // carries the full vocabulary. The binding list is a separate sentence with
      // a much shorter list of its own, and is checked against the binding table
      // by the test above.
      const line = skill
        .split("\n")
        .find((l) => l.includes("overrides[].property` is restricted to"));
      expect(line, "missing the overridable property list").toBeTruthy();
      const listed = [...line!.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]);
      sameSet(listed, OVERRIDABLE_PROPERTIES);
    });

    /**
     * dsl.md's reader authors documents; it never renames a component. A
     * sentence that explains itself by naming one teaches that reader nothing and
     * rots silently — `DocumentStage` survived in a sentence about presentation
     * until this check existed, and renaming the component would have gone
     * unnoticed because nothing else compares the prose to the source tree.
     */
    it("names no component from src/ui", async () => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
          const rel = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(rel);
          else if (entry.name.endsWith(".tsx")) files.push(rel);
        }
      };
      walk("src/ui");

      // Concurrent reads. `readFileSync` costs ~40ms per file inside a worker, which
      // put this test over vitest's 5s default on a slow filesystem — a timeout that
      // reads as "dsl.md names a component" when it means "the disk was busy".
      const codes = await Promise.all(files.map((file) => fs.promises.readFile(path.join(root, file), "utf-8")));
      const names = new Set<string>();
      for (const code of codes) {
        for (const m of code.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)/g)) names.add(m[1]);
        for (const m of code.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9]*)\s*[:=]/g)) names.add(m[1]);
      }
      // Without this the test would pass on an empty walk, which is what a
      // moved `src/ui` directory looks like from in here.
      expect(names.size, "found no exported ui symbols to check against").toBeGreaterThan(100);

      const leaked = [...names]
        .filter((name) => new RegExp(`\\b${name}\\b`).test(skill))
        .sort();
      expect(
        leaked,
        "dsl.md is read by external authors: explain a behaviour, not the component that implements it"
      ).toEqual([]);
    });

    // The one gap that cost an external agent real time: `normalize()` and
    // `exportCanvasSvg` shipped and went undocumented for a release, so the
    // author reverse-engineered what the normalizer had changed from the
    // geometry of the result. Prose has no compiler, so nothing else catches it.
    it("documents every window.__fish member, and nothing that was removed", () => {
      // The bridge lives in its own hook, not in the App body, but the contract
      // it publishes is the same one dsl.md documents.
      const hook = read("src/ui/hooks/useFishBridge.ts");
      const block = /__fish\s*=\s*\{([\s\S]*?)\n {4}\};/.exec(hook);
      expect(block, "could not read the __fish object out of useFishBridge.ts").toBeTruthy();
      // Indentation is what discriminates a member from the line it wraps onto:
      // members sit two levels in, a wrapped call body sits three. Matching either
      // the whole block or a line start picks up `id`, `options`, and the
      // implementation names the members delegate to.
      const members = [...block![1].matchAll(/^ {6}(?:get\s+)?([a-zA-Z]+)\s*[:(]/gm)].map((m) => m[1]);
      expect(members.length, "read no members out of __fish").toBeGreaterThan(4);
      for (const member of members) {
        expect(section("Inspection & Verification APIs"), `__fish.${member} is undocumented`).toContain(
          `\`${member}`
        );
      }
    });
  });

  /**
   * The headless channel is reachable only by opening a URL, so a rename or a
   * removal is invisible until an agent that installed nothing reports an empty
   * image. The parser is the whole contract, and these pin the two spellings that
   * silently disable it.
   */
  describe("headless report channel", () => {
    it("is wired to both the hook and the canvas-only view", () => {
      expect(read("src/main.tsx")).toContain("useHeadlessReport");
      expect(read("src/main.tsx")).toContain("headlessOrigin=");
      expect(read("src/ui/hooks/useHeadlessReport.ts")).toContain('id = REPORT_ID');
    });

    it("is documented for the author who has to reach it with a browser CLI", () => {
      const skill = read(DSL_DOC);
      expect(skill).toContain("report=1");
      expect(skill).toMatch(/--dump-dom|shot\.sh/);
    });
  });
});

/**
 * `sizing` names a MODE. A number there is the natural mistake — the DSL has a
 * top-level `width`/`height` for a pixel size and the two read alike — and it used
 * to be dropped in silence: the element kept whatever width it inherited, a text
 * node came out as wide as the canvas, and `repairs` was empty. The cost of that is
 * a document that renders as one full-width line and reports nothing wrong with it.
 */
describe("sizing modes are reported when they are not modes", () => {
  const repairsFor = (sizing: unknown) =>
    normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 800, height: 600 },
      elements: [{ id: "t", type: "text", content: "x", sizing, style: { fontSize: 14 } }]
    }).repairs.filter((r) => r.kind === "sizing");

  it("reports a number where a mode belongs, and says where a pixel size goes", () => {
    const [repair] = repairsFor({ width: 200 });
    expect(repair, "a numeric sizing.width was dropped in silence").toBeTruthy();
    expect(repair!.path).toBe("/elements/0/sizing/width");
    expect(repair!.message).toMatch(/not a sizing mode/);
    expect(repair!.message).toMatch(/element's own width/);
  });

  it("reports each axis separately", () => {
    const paths = repairsFor({ width: 200, height: 40 }).map((r) => r.path);
    expect(paths).toEqual(["/elements/0/sizing/width", "/elements/0/sizing/height"]);
  });

  it("reports a misspelt mode", () => {
    expect(repairsFor({ width: "wide" })).toHaveLength(1);
  });

  it("reports a misspelt shorthand instead of dropping the axis in silence", () => {
    const [repair] = repairsFor("max-contentpx");
    expect(repair, "a bad `sizing` string was dropped without a repair").toBeTruthy();
    expect(repair!.path).toBe("/elements/0/sizing");
    expect(repair!.message).toMatch(/not a sizing mode/);
  });

  it("stays silent for a real mode and for its aliases", () => {
    for (const sizing of [{ width: "fill" }, { width: "hug" }, { height: "auto" }, { width: "max-content" }]) {
      expect(repairsFor(sizing), JSON.stringify(sizing)).toHaveLength(0);
    }
  });

  it("still reports an unknown sizing key", () => {
    // Needs a width/height present: with neither, the object is reported whole as
    // carrying no axes, which is the more useful message and a different branch.
    expect(repairsFor({ width: "fill", depth: "fill" }).map((r) => r.path)).toContain(
      "/elements/0/sizing/depth"
    );
  });
});
