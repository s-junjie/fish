import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { elements, block, closers } from "./helpers/shell-walker";
import { serializeSelf, documentFromHtml, createEmptyDocument } from "../src/core/data-bridge";
import { writeDemoFixture } from "./helpers/demo-fixture";

/**
 * The splice contract — the properties a `.fish.html` file must keep forever.
 *
 * Why this is a file of its own rather than part of the compression tests:
 * a shipped file carries its updater INSIDE ITSELF, so the code that re-splices
 * a document into a newer shell is frozen the moment that file is written and
 * cannot be fixed by any later release. Save and the in-app shell upgrade both
 * go through `serializeSelf`, and it locates the document by markup — an id, a
 * type, an anchor. Break an invariant here and
 * the build still passes, the tests still pass, and files already on someone's
 * disk stop opening. `shell-compression.test.ts` is about how the shell is
 * PACKED; this file is about what the shell must always BE.
 *
 *   1. Every anchor a splicer keys off stays in plaintext, spelled the same way.
 *   2. No block can be terminated by its own contents.
 *   3. A splice round-trips: markup stays balanced, the document reads back
 *      unchanged, and doing it twice is the same as doing it once.
 *   4. A splice carries the WHOLE document, not one of its blocks.
 *   5. A splice leaves the file naming itself, not the shell it was poured into.
 */
const REPO = join(__dirname, "..");
const SHELL = join(REPO, "dist/index.html");
const KIT = join(REPO, "dist/fish-agent-kit");
const BLANK = join(KIT, "templates/blank.fish.html");

/** The opening tag every splicer matches on, verbatim. Renaming either half
 *  strands every file written before the rename. */
const DOC_OPEN = '<script id="design-doc" type="application/json">';
const ASSETS_OPEN = '<script id="fish-assets" type="application/json">';

/**
 * Everything a document value could carry that is markup somewhere else:
 * a script terminator, a comment opener, a CDATA terminator, the tag the
 * fallback anchor splices on, and a bidi override.
 */
const HOSTILE = [
  "</script><script>alert(1)</script>",
  "<!--",
  "<script",
  "]]>",
  "</head>",
  "</style>",
  "‮reorder",
  "${JSON.stringify(process)}"
].join("|");

function hostileDocument() {
  const doc = createEmptyDocument();
  doc.name = HOSTILE;
  return doc;
}

/** Every `</script` must be a real element's end: one extra and the file ends early. */
function isBalanced(html: string): boolean {
  return (
    closers(html, "script") === elements(html, "script").length &&
    closers(html, "style") === elements(html, "style").length
  );
}

describe.skipIf(!statSync(SHELL, { throwIfNoEntry: false }))("the splice contract", () => {
  // Collection runs even when the suite is skipped, so every read — and the demo
  // fixture's write — happens in a hook. Done here, a clean clone without `dist/`
  // failed at collection instead of skipping.
  let shell!: string;
  let demoPath!: string;
  let demo!: string;
  beforeAll(() => {
    shell = readFileSync(SHELL, "utf-8");
    demoPath = writeDemoFixture(shell);
    demo = readFileSync(demoPath, "utf-8");
  });

  describe("1 · the anchors stay in plaintext, spelled the same way", () => {
    // Paths are resolved per test: the demo fixture does not exist until the hook
    // has run, and a `for` over real paths would read it at collection.
    const artifacts: [string, () => string][] = [
      ["the built shell", () => SHELL],
      ["blank.fish.html", () => BLANK],
      ["the demo fixture", () => demoPath]
    ];

    for (const [name, file] of artifacts) {
      it(`${name} — carries the head anchor and one document block`, () => {
        const html = readFileSync(file(), "utf-8");
        // serializeSelf's last resort inserts after <head>; a shell without one
        // is wrapped whole, which is not the file the user saved.
        expect(/<head[^>]*>/i.test(html)).toBe(true);
        expect(html).toContain(DOC_OPEN);
        // one occurrence, not two: the bundle's own source must not spell it
        expect(html.split(DOC_OPEN)).toHaveLength(2);
      });

      it(`${name} — keeps the document block outside the compressed payloads`, () => {
        const html = readFileSync(file(), "utf-8");
        const payloads = elements(html, "script").filter((el) => el.attrs.includes("fish/deflate-b86"));
        expect(payloads.length).toBeGreaterThan(0);
        for (const el of payloads) expect(el.text).not.toContain("design-doc");
        // present and readable by markup alone; a blank file's block is empty,
        // which is still a block a frozen updater can find and fill.
        expect(block(html, "design-doc")).toBeDefined();
      });

      it(`${name} — has at most one assets block, and no markup inside either`, () => {
        const html = readFileSync(file(), "utf-8");
        expect(elements(html, "script").filter((el) => el.id === "fish-assets").length).toBeLessThanOrEqual(1);
        for (const id of ["design-doc", "fish-assets"]) {
          const el = block(html, id);
          if (!el) continue;
          expect(el.text.toLowerCase()).not.toContain("</script");
        }
      });
    }
  });

  describe("2 · no block can be terminated by its own contents", () => {
    it("escapes a hostile document so the markup still balances", () => {
      for (const base of [shell, demo]) {
        const out = serializeSelf(hostileDocument(), base);
        expect(block(out, "design-doc")!.text.toLowerCase()).not.toContain("</script");
        expect(isBalanced(out)).toBe(true);
      }
    });
  });

  describe("3 · a splice round-trips, and doing it twice is doing it once", () => {
    it("reads back the document it wrote, hostile values included", () => {
      const out = serializeSelf(hostileDocument(), shell);
      expect(documentFromHtml(out)!.name).toBe(HOSTILE);
    });

    it("does not accumulate blocks when a shipped updater splices again", () => {
      // The case this pins: an already-saved file re-saving, or an old shell's
      // updater splicing into a newer one. One meta, one document block, one
      // assets block — never one more per write.
      const once = serializeSelf(hostileDocument(), shell);
      const twice = serializeSelf(documentFromHtml(once)!, once);
      for (const html of [once, twice]) {
        expect(elements(html, "script").filter((el) => el.id === "design-doc")).toHaveLength(1);
        expect((html.match(/name="fish:fileId"/g) ?? []).length).toBe(1);
        expect(isBalanced(html)).toBe(true);
      }
      expect(documentFromHtml(twice)!.name).toBe(HOSTILE);
    });

    it("leaves the shell's own identity alone when it is not a new file", () => {
      // freshFileId is the one flag that mints: a Save As is a different file.
      // Everything else must keep the id the shell already carried.
      const once = serializeSelf(createEmptyDocument(), shell);
      const twice = serializeSelf(documentFromHtml(once)!, once, { freshFileId: true });
      expect((twice.match(/name="fish:fileId"/g) ?? []).length).toBe(1);
    });
  });

  describe("4 · a splice carries the whole document", () => {
    it("transplants the assets block along with the element tree", () => {
      // data-bridge splits bitmaps into `#fish-assets` so the element tree stays
      // readable. A splicer that moves only `#design-doc` therefore carries a
      // document with every image reference pointing at nothing — the upgrade
      // succeeds and the pictures are gone.
      const before = documentFromHtml(demo)!;
      expect(before.assets?.length ?? 0).toBeGreaterThan(0);
      const out = serializeSelf(before, shell);
      const after = documentFromHtml(out)!;
      expect(after.name).toBe(before.name);
      expect(after.assets).toEqual(before.assets);
      expect(out).toContain(ASSETS_OPEN);
      expect(block(out, "fish-assets")!.text).toBe(block(demo, "fish-assets")!.text);
      expect(isBalanced(out)).toBe(true);
    });
  });

  describe("5 · a splice leaves the file naming itself", () => {
    it("writes the target's name over the shell's own title", () => {
      // The shell a release ships under the app's name is the template, not the
      // file: a save that left its title alone would write a document into a file
      // that still calls itself the app, in every tab it is ever opened in.
      const out = serializeSelf(createEmptyDocument(), shell, { title: "my-design — FISH" });
      expect(out).toContain("<title>my-design — FISH</title>");
      expect((out.match(/<title>/g) ?? []).length).toBe(1);
    });

    it("keeps exactly one title when a shipped updater splices again", () => {
      const once = serializeSelf(createEmptyDocument(), shell, { title: "my-design — FISH" });
      const twice = serializeSelf(documentFromHtml(once)!, once, { title: "my-design — FISH" });
      expect((twice.match(/<title>/g) ?? []).length).toBe(1);
      expect(twice).toContain("<title>my-design — FISH</title>");
    });
  });
});
