import { describe, it, expect, afterEach } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import type { DesignDocument } from "../src/core/dsl/types";
import { fakeDocumentElement, stubDocument } from "./helpers/fake-document";
import {
  getFileId,
  getLoadFailure,
  getOpenedFileHash,
  loadInitialDocument,
  readFileIdFromShell,
  readFileBackup,
  serializeSelf,
  writeFileSafely,
  payloadHashFromHtml,
  payloadTextFromHtml,
  documentFromHtml,
  createEmptyDocument,
  setFileHandle,
  clearFileHandle
} from "../src/core/data-bridge";
import { computeContentHash, computePayloadHash } from "../src/core/persistence/recovery";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";

function makeDoc(): DesignDocument {
  return {
    docId: "fish_doc_a",
    id: "doc_x",
    version: "0.1",
    name: "My Design",
    canvas: { width: 100, height: 100, unit: "px" },
    elements: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }],
    assets: []
  } as unknown as DesignDocument;
}

const realDocument = (globalThis as any).document;
afterEach(() => {
  (globalThis as any).document = realDocument;
});

describe("file identity", () => {
  it("stamps a fileId into the shell it writes", () => {
    const shell = "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";
    const first = serializeSelf(makeDoc(), shell);
    const id = /<meta\s+name="fish:fileId"\s+content="([^"]+)"/.exec(first)?.[1];
    // Matched against the real shape, not just "something was captured": an
    // un-interpolated template literal would satisfy `toBeTruthy()` while
    // writing the literal `${f}` into every saved file.
    expect(id).toMatch(/^file_[0-9a-z]+_[0-9a-z]+$/);
  });

  it("keeps the id the page already carries", () => {
    // Re-saving must reuse the stamp already on the page. Minting a fresh one on
    // every write would orphan all the history recorded under the previous id.
    (globalThis as any).document = {
      querySelector: (sel: string) =>
        sel.includes("fish:fileId") ? { getAttribute: () => "file_existing_id" } : null
    };
    const shell = "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";
    const out = serializeSelf(makeDoc(), shell);
    expect(/<meta\s+name="fish:fileId"\s+content="([^"]+)"/.exec(out)?.[1]).toBe("file_existing_id");
  });

  it("mints a fresh id on request even when the page already carries one", () => {
    // "Save As" / "New File" / version export must not inherit the source file's
    // id — that id keys the recovery snapshot, version timeline and FSA handle,
    // so sharing it would merge two files onto one history and one write-back.
    (globalThis as any).document = {
      querySelector: (sel: string) =>
        sel.includes("fish:fileId") ? { getAttribute: () => "file_existing_id" } : null
    };
    const shell = "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";
    const out = serializeSelf(makeDoc(), shell, { freshFileId: true });
    const id = /<meta\s+name="fish:fileId"\s+content="([^"]+)"/.exec(out)?.[1];
    expect(id).not.toBe("file_existing_id");
    expect(id).toMatch(/^file_[0-9a-z]+_[0-9a-z]+$/);
  });

  it("still reads the id when the document block is unparseable", () => {
    // The whole point of keying recovery on the file rather than on `docId`:
    // a truncated document block yields no `docId`, but the shell — and so the
    // file's identity — is still there to look up the snapshot by.
    (globalThis as any).document = {
      querySelector: (sel: string) =>
        sel.includes("fish:fileId") ? { getAttribute: () => "file_abc" } : null
    };
    expect(readFileIdFromShell()).toBe("file_abc");
    expect(getFileId()).toBe("file_abc");

    const truncated =
      '<html><head><meta name="fish:fileId" content="file_abc">' +
      '<script id="design-doc" type="application/json">{"broken":</script></head></html>';
    // The file's identity survives a block we cannot read — the same reason the
    // `fileId` stamp exists. A hash taken through the parser would return
    // nothing here, and the snapshot would be filed under nothing.
    expect(payloadHashFromHtml(truncated)).toBeDefined();
    expect(payloadHashFromHtml("<html><body>no block at all</body></html>")).toBeUndefined();
  });

  it("falls back to the file name when the page carries no stamp", () => {
    (globalThis as any).document = { querySelector: () => null };
    expect(getFileId()).toBe("unknown-file");
  });
});

describe("save escaping", () => {
  const shell = "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";

  it("escapes only '</', so text stays readable and the block cannot be terminated", () => {
    const doc = { ...makeDoc(), name: "A </script> B <b>bold</b>" } as DesignDocument;
    const out = serializeSelf(doc, shell);

    // Exactly one real `</script>`: the one that closes the block. A literal
    // `</script>` inside a string must not be able to end it early.
    expect(out.match(/<\/script>/g)).toHaveLength(1);
    // A bare `<` is left alone — escaping all of them also worked, but made
    // ordinary text unreadable on disk and invisible to grep. Only the `</`
    // form is escaped, which is why `</b>` is gone and `<b>` survives.
    expect(out).toContain("<b>bold");
    expect(out).not.toContain("</b>");
    expect(documentFromHtml(out)?.name).toBe("A </script> B <b>bold</b>");
  });
});

describe("write-path backup", () => {
  const handle = {
    name: "a.fish.html",
    getFile: async () => ({ text: async () => "<html>THE PREVIOUS FILE</html>" }),
    createWritable: async () => ({ write: async () => undefined, close: async () => undefined })
  };

  it("keeps the file's previous contents before overwriting it", async () => {
    // Not a `.bak` sibling — creating one needs a user gesture, so it could
    // never happen inside an auto-save flush. This is what makes a file that
    // gets damaged recoverable: the state right before our own last write.
    stubDocument({ querySelector: () => null });
    await writeFileSafely(makeDoc(), handle);
    expect(await readFileBackup(getFileId())).toBe("<html>THE PREVIOUS FILE</html>");
  });

  it("still writes when the backup cannot be taken", async () => {
    let written = false;
    await writeFileSafely(makeDoc(), {
      name: "b.fish.html",
      getFile: async () => {
        throw new Error("no read permission");
      },
      createWritable: async () => ({
        write: async () => {
          written = true;
        },
        close: async () => undefined
      })
    });
    expect(written).toBe(true);
  });

  it("reports that a write landed without a safety net", async () => {
    // The user asked for this save, so it proceeds — but the outcome has to say
    // the pre-write copy is missing rather than reporting a clean success.
    const outcome = await writeFileSafely(makeDoc(), {
      name: "c.fish.html",
      getFile: async () => {
        throw new Error("no read permission");
      },
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined })
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.backupFailed).toBe(true);
  });

  it("refuses an unprompted write when there is no safety net", async () => {
    // `requireBackup` is what the auto-save write-back uses: nobody pressed
    // save, so overwriting the file on top of no recoverable copy can lose work
    // with no user action at all.
    let written = false;
    const outcome = await writeFileSafely(
      makeDoc(),
      {
        name: "d.fish.html",
        getFile: async () => {
          throw new Error("no read permission");
        },
        createWritable: async () => ({
          write: async () => {
            written = true;
          },
          close: async () => undefined
        })
      },
      undefined,
      { requireBackup: true }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/^backup-unavailable:/);
    expect(written).toBe(false);
  });
});

/**
 * `createWritable()` defaults `keepExistingData` to false, which truncates the
 * file to zero bytes before `write` runs. A quota or permission error anywhere
 * in the write then leaves an empty file where the user's design was, and the
 * only copy is the backup — which itself lives in IndexedDB and may not exist.
 */
describe("write path does not destroy the file on failure", () => {
  const withDom = () => {
    stubDocument({ querySelector: () => null });
  };

  it("keeps the existing file data until the write closes", async () => {
    withDom();
    let opts: unknown;
    await writeFileSafely(makeDoc(), {
      name: "e.fish.html",
      getFile: async () => ({ text: async () => "<html>PREVIOUS</html>" }),
      createWritable: async (o: unknown) => {
        opts = o;
        return { write: async () => undefined, close: async () => undefined };
      }
    });
    expect(opts).toEqual({ keepExistingData: true });
  });

  it("cuts the temp file to the bytes written, so no stale tail survives", async () => {
    // `keepExistingData` starts the temp file as a copy of the old one and
    // `write` never shortens it: saving a smaller document into a larger file
    // used to leave the previous file's tail behind — a second runtime payload,
    // a second #app, and a shell that refused to boot.
    withDom();
    const doc = makeDoc();
    doc.name = "Revenue — 收入";
    let written = "";
    let cut: number | undefined;
    let closedAt = -1;
    const order: string[] = [];
    await writeFileSafely(doc, {
      name: "e2.fish.html",
      getFile: async () => ({ text: async () => "<html>PREVIOUS</html>" }),
      createWritable: async () => ({
        write: async (s: string) => {
          written = s;
          order.push("write");
        },
        truncate: async (n: number) => {
          cut = n;
          order.push("truncate");
        },
        close: async () => {
          closedAt = order.length;
          order.push("close");
        }
      })
    });
    expect(order).toEqual(["write", "truncate", "close"]);
    expect(closedAt).toBe(2);
    // Bytes, not characters: the name above is wider than its length.
    expect(cut).toBe(new TextEncoder().encode(written).byteLength);
    expect(cut).toBeGreaterThan(written.length);
  });

  it("aborts the temp file and rethrows when the write fails", async () => {
    withDom();
    let aborted = false;
    let closed = false;
    const err = new Error("QuotaExceededError");
    await expect(
      writeFileSafely(makeDoc(), {
        name: "f.fish.html",
        getFile: async () => ({ text: async () => "<html>PREVIOUS</html>" }),
        createWritable: async () => ({
          write: async () => {
            throw err;
          },
          close: async () => {
            closed = true;
          },
          abort: async () => {
            aborted = true;
          }
        })
      })
    ).rejects.toBe(err);
    // abort() discards the temp file, so the original survives; close() must
    // never have run, or the file would already be replaced.
    expect(aborted).toBe(true);
    expect(closed).toBe(false);
  });

  it("aborts when close() is what fails", async () => {
    withDom();
    let aborted = false;
    await expect(
      writeFileSafely(makeDoc(), {
        name: "g.fish.html",
        getFile: async () => ({ text: async () => "<html>PREVIOUS</html>" }),
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => {
            throw new Error("NoModificationAllowedError");
          },
          abort: async () => {
            aborted = true;
          }
        })
      })
    ).rejects.toThrow(/NoModificationAllowedError/);
    expect(aborted).toBe(true);
  });

  it("surfaces the original failure when abort() itself throws", async () => {
    withDom();
    await expect(
      writeFileSafely(makeDoc(), {
        name: "h.fish.html",
        getFile: async () => ({ text: async () => "<html>PREVIOUS</html>" }),
        createWritable: async () => ({
          write: async () => {
            throw new Error("the real problem");
          },
          close: async () => undefined,
          abort: async () => {
            throw new Error("abort is not supported after close");
          }
        })
      })
    ).rejects.toThrow(/the real problem/);
  });
});

describe("asset block split", () => {
  const shell = "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";
  const uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";
  const withAsset = {
    ...makeDoc(),
    assets: [{ id: "a1", name: "img", uri }]
  } as unknown as DesignDocument;

  const blocks = (html: string) => ({
    doc: /<script\s+id="design-doc"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "",
    assets: /<script\s+id="fish-assets"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""
  });

  it("moves the bitmaps out of the structure block", () => {
    const out = serializeSelf(withAsset, shell);
    const { doc, assets } = blocks(out);

    expect(JSON.parse(doc).assets[0].uri).toBeUndefined();
    expect(JSON.parse(assets)).toEqual({ a1: uri });
    // The point of the split: the structure block is no longer a wall of base64.
    expect(doc).not.toContain("base64");
    expect(assets).toContain("base64");
  });

  it("writes no asset block at all when there are no bitmaps", () => {
    // An empty block would be noise in every bitmap-free document.
    expect(blocks(serializeSelf(makeDoc(), shell)).assets).toBe("");
  });

  it("identifies the file by its own text, not by what it parses to", () => {
    // The whole point of the payload hash: the engine may change shape, migrate
    // or relayout anything it likes, and a file nobody touched keeps its
    // identity. Anything derived from the document would move under it — and a
    // fork anchor that moves on an engine change strands the history of every
    // existing file, then deletes it.
    const out = serializeSelf(withAsset, shell);
    // The bitmaps live in a separate block, so the structure block no longer
    // carries them: the hash cannot depend on asset inlining at all.
    expect(payloadTextFromHtml(out)).not.toContain("base64");
    expect(payloadHashFromHtml(out)).toBe(
      computePayloadHash(payloadTextFromHtml(out)!.trim())
    );
    expect(documentFromHtml(out)?.assets?.[0].uri).toBe(uri);
  });

  it("still reads a file that keeps its bitmaps inside the structure block", () => {
    // The older layout. It parses to the same document and it identifies itself
    // the same way any other file does — by its own text — so it needs no
    // special case in the hash.
    const legacy = `<html><head><script id="design-doc" type="application/json">${JSON.stringify(
      withAsset
    ).replace(/<\//g, "\\u003c/")}</script></head></html>`;
    expect(documentFromHtml(legacy)?.assets?.[0].uri).toBe(uri);
    expect(payloadHashFromHtml(legacy)).toBeDefined();
  });

  it("drops a stale asset block when the document loses its bitmaps", () => {
    const withAssets = serializeSelf(withAsset, shell);
    const without = serializeSelf(makeDoc(), withAssets);
    expect(blocks(without).assets).toBe("");
  });
});

describe("normalization reaches every reader", () => {
  const docBlock = (doc: unknown) =>
    `<html><head><script id="design-doc" type="application/json">${JSON.stringify(doc)}</script></head></html>`;

  it("hashes a document the same before and after normalization", () => {
    // The identity check compares a hash of the live document against a hash of
    // the file. If only one side normalized, the two would diverge and the user's
    // own file would be refused as "not the one open in this tab".
    const at01 = { ...makeDoc(), version: "0.1" } as DesignDocument;
    const normalized = normalizeDesignDocument(at01, { preserveUnknown: true }).document;
    expect(computeContentHash(normalized)).toBe(computeContentHash(at01));
  });

  it("still recognises a file written at an older version", () => {
    const at01 = { ...makeDoc(), version: "0.1" };
    (globalThis as any).document = {
      getElementById: () => ({ textContent: JSON.stringify(at01) }),
      querySelector: () => null,
      documentElement: fakeDocumentElement("<html></html>")
    };
    loadInitialDocument();
    expect(payloadHashFromHtml(docBlock(at01))).toBe(getOpenedFileHash());
  });

  it("writes the latest version to disk", () => {
    // Otherwise the migration would be re-applied on every single open.
    const out = serializeSelf(
      { ...makeDoc(), version: "0.1" } as DesignDocument,
      "<html><head></head><body></body></html>"
    );
    const body = /<script\s+id="design-doc"[^>]*>([\s\S]*?)<\/script>/.exec(out)?.[1] ?? "{}";
    expect(JSON.parse(body).version).toBe(LATEST_DOCUMENT_VERSION);
  });
});

describe("shells whose inline bundle mentions the same literals", () => {
  // A faithful stand-in for the real build: the bundle is inlined into head and
  // its own source contains the very strings we search for. `</script>` inside
  // it is escaped, as any bundler must, or it would terminate the script tag.
  const pollutedShell = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    "<title>FISH</title>",
    "<script>",
    'const meta=`<meta name="fish:fileId" content="${f}">`;',
    'const block=`<script id="design-doc" type="application/json">\\n${x}\\n  <\\/script>`;',
    'if(!u.includes("</head>"))u.replace(/<html[^>]*>/i,m=>`${m}\\n<head>${p}</head>`);',
    "</script>",
    "</head>",
    "<body></body>",
    "</html>"
  ].join("\n");

  const stampedIds = (html: string) =>
    [...html.matchAll(/content="(file_[^"]+)"/g)].map((m) => m[1]);

  it("stamps a real id instead of adopting the bundle's own literal", () => {
    // The regression: the id was scanned out of the HTML text, so it matched the
    // literal inside the bundle and every file ended up sharing one identity —
    // which is how a handle for one file got handed to another.
    const out = serializeSelf(makeDoc(), pollutedShell);
    const ids = stampedIds(out);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^file_[0-9a-z]+_[0-9a-z]+$/);
  });

  it("does not accumulate stamps across saves", () => {
    const once = serializeSelf(makeDoc(), pollutedShell);
    const twice = serializeSelf(makeDoc(), once);
    expect(stampedIds(twice)).toHaveLength(1);
  });

  it("still reads the document out of a polluted shell", () => {
    // The regex could match the block literal inside the bundle instead of the
    // real one, which would give every file the same identity.
    const out = serializeSelf(makeDoc(), pollutedShell);
    expect(documentFromHtml(out)?.name).toBe(makeDoc().name);
    expect(JSON.parse(payloadTextFromHtml(out)!.trim()).name).toBe(makeDoc().name);
  });
});

describe("fileId stamp adoption", () => {
  const installDom = () => {
    const metas: any[] = [];
    (globalThis as any).document = {
      querySelector: () => metas[0] ?? null,
      createElement: () => ({
        attrs: {} as Record<string, string>,
        setAttribute(this: any, k: string, v: string) {
          this.attrs[k] = v;
        },
        getAttribute(this: any, k: string) {
          return this.attrs[k] ?? null;
        }
      }),
      head: { appendChild: (el: unknown) => metas.push(el) },
      documentElement: fakeDocumentElement("<html></html>")
    };
    return metas;
  };

  it("adopts the written stamp so the handle can be found on the next load", async () => {
    // Without this the handle is filed under the name-derived fallback id, while
    // the next load reads the real stamp out of the file — the two never match,
    // so the user is asked to pick the same file again on every single open.
    const metas = installDom();
    await writeFileSafely(makeDoc(), {
      name: "a.fish.html",
      getFile: async () => ({ text: async () => "" }),
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined })
    });

    expect(metas).toHaveLength(1);
    expect(getFileId()).toBe(metas[0].attrs.content);
    expect(getFileId().startsWith("file_")).toBe(true);
  });
});

describe("load failure", () => {
  it("reports a corrupt document block instead of pretending the file was empty", () => {
    (globalThis as any).document = {
      querySelector: () => null,
      getElementById: () => ({ textContent: '{"broken":' }),
      documentElement: fakeDocumentElement("<html></html>")
    };
    const doc = loadInitialDocument();
    expect(getActivePage(doc).children).toEqual([]);
    expect(getLoadFailure()).toBeTruthy();
    // The baseline is the file's own text, so it exists even though nothing
    // could be read out of it.
    expect(getOpenedFileHash()).toBe(computePayloadHash('{"broken":'));
  });
});

describe("the identity baseline follows the file", () => {
  const realWindow = (globalThis as any).window;

  const openAs = (file: string) => {
    (globalThis as any).window = { location: { pathname: `/dir/${file}` } };
  };

  // Any baseline at all, taken the way a real boot takes it.
  const seedBaseline = () => {
    (globalThis as any).document = {
      getElementById: () => ({ textContent: '{"seed":1}' }),
      querySelector: () => null,
      documentElement: fakeDocumentElement("<html></html>")
    };
    loadInitialDocument();
    return getOpenedFileHash();
  };

  const writeTo = (name: string) => {
    stubDocument({ querySelector: () => null });
    return writeFileSafely(makeDoc(), {
      name,
      getFile: async () => ({ text: async () => "<html>PREVIOUS</html>" }),
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined })
    });
  };

  afterEach(() => {
    (globalThis as any).window = realWindow;
    clearFileHandle();
  });

  it("moves with the bytes that landed", async () => {
    // Otherwise a later relink compares the picked file against the file as it
    // was opened and refuses the user's own file — it has moved on since.
    openAs("a.fish.html");
    const before = seedBaseline();
    const outcome = await writeTo("a.fish.html");
    expect(getOpenedFileHash()).toBe(outcome.payloadHash);
    expect(getOpenedFileHash()).not.toBe(before);
  });

  it("stays put when the write went to a differently named file", async () => {
    // A ⌘S save-as is not the file this tab is showing: moving the baseline to
    // it would make the next relink accept that copy instead.
    openAs("a.fish.html");
    const before = seedBaseline();
    await writeTo("elsewhere.fish.html");
    expect(getOpenedFileHash()).toBe(before);
  });

  it("follows the handle once a save-as adopts the new file", async () => {
    // After adoption this tab is editing the new file, so the identity check
    // must compare picks against it — otherwise every later relink refuses the
    // user's own file.
    openAs("a.fish.html");
    const before = seedBaseline();
    setFileHandle({ name: "elsewhere.fish.html" });
    const outcome = await writeTo("elsewhere.fish.html");
    expect(getOpenedFileHash()).toBe(outcome.payloadHash);
    expect(getOpenedFileHash()).not.toBe(before);
  });
});

describe("payloadHashFromHtml", () => {
  const wrap = (body: string) =>
    `<html><head><script id="design-doc" type="application/json">${body}</script></head></html>`;

  it("gives an empty shell a baseline of its own", () => {
    // An empty shell must still produce a baseline, otherwise the write-back
    // picker skips its check and any file can be adopted — and overwritten.
    expect(payloadHashFromHtml(wrap(""))).toBe(computePayloadHash(""));
    expect(payloadHashFromHtml(wrap("\n  "))).toBe(computePayloadHash(""));
  });

  it("ignores the surrounding whitespace the serializer adds", () => {
    // The writer indents the block; a reload must not read that as an edit.
    expect(payloadHashFromHtml(wrap("\n  {\"a\":1}\n  "))).toBe(
      payloadHashFromHtml(wrap('{"a":1}'))
    );
  });

  it("changes when the text changes, however small", () => {
    expect(payloadHashFromHtml(wrap('{"a":1}'))).not.toBe(payloadHashFromHtml(wrap('{"a":2}')));
  });

  it("does not consult the document at all", () => {
    // Two texts that normalize to the same document still identify two different
    // files, and text that is not a document at all still identifies its own.
    // That is what keeps an engine change from re-identifying every file.
    expect(payloadHashFromHtml(wrap("not json"))).toBeDefined();
    expect(payloadHashFromHtml(wrap("not json"))).not.toBe(
      computeContentHash(createEmptyDocument())
    );
  });

  it("returns undefined for anything that is not a FISH document", () => {
    expect(payloadHashFromHtml("<html><body>hi</body></html>")).toBeUndefined();
  });
});
