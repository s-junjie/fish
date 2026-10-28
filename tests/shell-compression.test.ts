import { describe, it, expect, beforeAll } from "vitest";
import { deflateRawSync, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { encode, decode, ALPHABET, BASE, FORBIDDEN, LOADER_DECODER } from "../scripts/lib/b86.mjs";
import { inflateRaw } from "../scripts/lib/inflate-raw.js";
import { elements } from "./helpers/shell-walker";
import { demoFixtureHtml } from "./helpers/demo-fixture";

const REPO = join(__dirname, "..");
const SHELL = join(REPO, "dist/index.html");

describe("b86", () => {
  it("uses 86 symbols and none that can close a tag, comment or template", () => {
    expect(BASE).toBe(86);
    expect(new Set(ALPHABET).size).toBe(86);
    for (const ch of "<>&\"'\\-{ ") expect(ALPHABET).not.toContain(ch);
    for (const ch of ALPHABET) expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x21);
  });

  it("beats base64's wire cost, which is the only reason it exists", () => {
    // 86^5 > 2^32, so 4 bytes in 5 chars is dense and not a coincidence of rounding
    expect(Math.pow(BASE, 5)).toBeGreaterThan(Math.pow(2, 32));
    for (const length of [100, 5000, 70000]) {
      expect(encode(randomBytes(length)).length).toBe(Math.ceil(length / 4) * 5);
      expect(encode(randomBytes(length)).length).toBeLessThan(Math.ceil((length / 3) * 4));
    }
  });

  it("round trips every tail length, including the empty input", () => {
    for (let length = 0; length <= 64; length++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const source = randomBytes(length);
        const decoded = decode(encode(source));
        expect(Buffer.from(decoded).equals(source)).toBe(true);
      }
    }
  });

  it("carries hostile bytes without ever spelling a dangerous sequence", () => {
    const hostile = Buffer.from("</script><!-- -->]]>${}<script>\"'\\-{}".repeat(64));
    const text = encode(hostile);
    for (const needle of [...FORBIDDEN, "<script"]) expect(text).not.toContain(needle);
    expect(Buffer.from(decode(text)).equals(hostile)).toBe(true);
    for (let attempt = 0; attempt < 5000; attempt++) {
      const payload = encode(randomBytes(1 + (attempt % 96)));
      for (const needle of FORBIDDEN) expect(payload).not.toContain(needle);
    }
  });

  it("refuses text it cannot decode rather than returning garbage", () => {
    expect(() => decode("a")).toThrow(/lone trailing/);
    expect(() => decode("ab<de")).toThrow(/alphabet/);
    expect(() => decode("     ")).toThrow(/alphabet/);
  });

  it("matches the decoder copy inlined into the loader, byte for byte", () => {
    const inlined = new Function(`${LOADER_DECODER}\nreturn fishB86Decode`)();
    for (let length = 0; length <= 80; length++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const source = randomBytes(length);
        const text = encode(source);
        expect(Buffer.from(Buffer.from(inlined(text))).equals(Buffer.from(decode(text)))).toBe(true);
        expect(Buffer.from(Buffer.from(inlined(text))).equals(source)).toBe(true);
      }
    }
  });
});

describe("the shell's own inflate", () => {
  it("reproduces zlib's output across every level and block shape", () => {
    const samples: Record<string, Buffer> = {
      empty: Buffer.alloc(0),
      single: Buffer.from([255]),
      zeros: Buffer.alloc(300000),
      runs: Buffer.from("ab".repeat(150000)),
      counting: Buffer.from(Array.from({ length: 60000 }, (_, i) => i & 255)),
      text: Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(4000)),
      stored: randomBytes(65535)
    };
    for (const level of [0, 1, 6, 9]) {
      for (const [name, sample] of Object.entries(samples)) {
        const packed = deflateRawSync(sample, { level });
        expect(Buffer.from(inflateRaw(packed)).equals(sample), `${name} @ level ${level}`).toBe(true);
      }
    }
  });

  it("fails loudly on a wrapped, truncated or corrupt stream", () => {
    expect(() => inflateRaw(deflateSync(Buffer.from("x")))).toThrow();
    const packed = deflateRawSync(randomBytes(40000));
    expect(() => inflateRaw(packed.subarray(0, 6))).toThrow();
    expect(() => inflateRaw(new Uint8Array(0))).toThrow();
  });
});

/**
 * The built files, not fixtures: `npm run build` runs the compressor and the
 * loader has to survive the exact bundle it is handed today.
 */
describe.skipIf(!statSync(SHELL, { throwIfNoEntry: false }))("the built shell", () => {
  // `describe.skipIf` marks the tests skipped but still runs this callback at
  // collection, so a read here turns "no dist/ yet" (a clean clone, before
  // `npm run build`) into a failed suite instead of a skipped one. Read in a hook.
  let shell!: string;
  let withDoc!: string;
  beforeAll(() => {
    shell = readFileSync(SHELL, "utf-8");
    withDoc = demoFixtureHtml(shell);
  });

  it("carries the runtime and stylesheet as payload blocks, not as plaintext", () => {
    expect(shell).not.toContain('<script type="module"');
    expect(shell).not.toContain('<style rel="stylesheet"');
    const payloads = elements(shell, "script").filter((el) => el.attrs.includes("fish/deflate-b86"));
    expect(payloads.map((el) => el.id)).toEqual(["fish-rt-css", "fish-rt"]);
  });

  it("rebuilds both payloads through the loader's own path", () => {
    const decodeInlined = new Function(`${LOADER_DECODER}\nreturn fishB86Decode`)();
    for (const el of elements(shell, "script").filter((e) => e.attrs.includes("fish/deflate-b86"))) {
      const text = new TextDecoder().decode(inflateRaw(decodeInlined(el.text)));
      expect(text.length).toBe(Number(/data-chars="(\d+)"/.exec(el.attrs)?.[1]));
      expect(text).toMatch(el.id === "fish-rt-css" ? /--tw-|box-sizing/ : /createRoot|__FISH_BRIDGE__/);
    }
  });

  it("injects the decoded stylesheet and runtime when it runs", () => {
    // the loader itself, executed against a DOM small enough to read: the one thing
    // that can turn every file into a blank page is a loader that quietly fails, and
    // no test that only inspects the HTML would notice
    const payloads = elements(shell, "script").filter((el) => el.attrs.includes("fish/deflate-b86"));
    const loaderSource = elements(shell, "script").find((el) => el.attrs === "")!.text;
    const injected: { tag: string; text: string }[] = [];
    const host = { textContent: "" };
    const nodes = payloads.map((el) => ({
      id: el.id,
      textContent: el.text,
      attrs: Object.fromEntries([...el.attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])),
      getAttribute: (key: string) => ({ "data-chars": el.attrs.match(/data-chars="(\d+)"/)?.[1] })[key] ?? null
    }));
    const fakeDocument = {
      getElementById: () => host,
      querySelectorAll: (selector: string) =>
        selector.includes("fish-transient") ? [] : selector.includes("fish/deflate-b86") ? nodes : [],
      createElement: (tag: string) => ({
        tag,
        textContent: "",
        attrs: {} as Record<string, string>,
        setAttribute(this: any, key: string, value: string) {
          this.attrs[key] = value;
        }
      }),
      head: { appendChild: (el: any) => injected.push({ tag: el.tag, text: el.textContent }) },
      body: { appendChild: (el: any) => injected.push({ tag: el.tag, text: el.textContent }) }
    };
    new Function("document", "console", loaderSource)(fakeDocument, { error: () => {} });
    expect(host.textContent, "the loader reported a failure").toBe("");
    expect(injected.map((el) => el.tag)).toEqual(["style", "script"]);
    expect(loaderSource).toContain("fish-rt-css");
    expect(injected[0].text).toMatch(/box-sizing/);
    expect(injected[1].text).toMatch(/__FISH_BRIDGE__/);
  });

  it("refuses a payload whose character count does not match", () => {
    const payloads = elements(shell, "script").filter((el) => el.attrs.includes("fish/deflate-b86"));
    const loaderSource = elements(shell, "script").find((el) => el.attrs === "")!.text;
    const host = { textContent: "" };
    const nodes = payloads.map((el) => ({
      id: el.id,
      textContent: el.text,
      getAttribute: (key: string) => (key === "data-chars" ? "1" : null)
    }));
    new Function("document", "console", loaderSource)({
      getElementById: () => host,
      // `fail()` clears the preview cover first (`24acd7f`), so the stub has to
      // answer that query separately — `remove()` lives on those nodes only.
      querySelectorAll: (s: string) =>
        s.includes("fish-transient") || s.includes("data-fish-preview") ? [] : nodes,
      createElement: (tag: string) => ({ tag, textContent: "", setAttribute: () => {} }),
      head: { appendChild: () => {} },
      body: { appendChild: () => {} }
    }, { error: () => {} });
    expect(host.textContent).toContain("could not be unpacked");
  });

  it("leaves the document, the assets and every non-linked style in plaintext", () => {
    // the blank shell carries no assets block at all — vite strips it — so the
    // reset style and the document block are what both files must still spell out
    for (const needle of ['<script id="design-doc"', "background-color: #121212"]) {
      expect(shell).toContain(needle);
      expect(withDoc).toContain(needle);
    }
    expect(withDoc).toContain('<script id="fish-assets"');
    expect(shell).not.toContain('<script id="fish-assets"');
    const doc = elements(withDoc, "script").find((el) => el.id === "design-doc");
    expect(() => JSON.parse(doc!.text)).not.toThrow();
    expect(doc!.text.length).toBeGreaterThan(100_000);
  });

  it("cannot be terminated early by its own contents", () => {
    for (const file of [shell, withDoc]) {
      // a browser ends an element at the first `</script` in the file, so the number
      // of those markers has to equal the number of real elements
      for (const tag of ["script", "style"]) {
        expect((file.match(new RegExp(`</${tag}`, "gi")) ?? []).length).toBe(elements(file, tag).length);
      }
      for (const el of elements(file, "script").filter((e) => e.attrs.includes("fish/deflate-b86"))) {
        for (const needle of FORBIDDEN) expect(el.text).not.toContain(needle);
      }
    }
  });

  it("reaches the agent kit and a document spliced into the built shell", () => {
    const blank = readFileSync(join(REPO, "dist/fish-agent-kit/templates/blank.fish.html"), "utf-8");
    expect(blank).not.toContain('<script type="module"');
    expect(blank).toContain('type="fish/deflate-b86"');

    expect(withDoc).not.toContain('<script type="module"');
    expect(withDoc).toContain('type="fish/deflate-b86"');
  });
});

describe("the compressor's markup walker", () => {
  // The trap this exists for: the uncompressed bundle carries the markup for both
  // document blocks as template-literal text, so `/id="fish-assets"/` finds 597 KB
  // of JavaScript where the build expected a JSON payload.
  const trap = [
    `<script id="design-doc" type="application/json">{"name":"real"}</script>`,
    `<script id="fish-assets" type="application/json">{"real":"asset"}</script>`,
    `<script type="module">let s=\`<script id="fish-assets" type="application/json">\n\${JSON.stringify(i,null,2)}\n  <\/script>\`;</script>`,
    `<style>body{background:#121212}</style>`
  ].join("\n");

  it("sees three scripts, not the four a byte-level count would find", () => {
    expect((trap.match(/<script/g) ?? []).length).toBe(4);
    const scripts = elements(trap, "script");
    expect(scripts.map((el) => el.id)).toEqual(["design-doc", "fish-assets", ""]);
    // and the decoy is still text, not a fourth element that truncated the module
    expect(scripts[2].text).toContain('<script id="fish-assets"');
    expect(scripts[2].text).toContain("${JSON.stringify(i,null,2)}");
    expect(elements(trap, "style")).toHaveLength(1);
  });

  it("reads the real block body whole, where a regex would stop at the decoy", () => {
    // the decoy sits first here, which is the blank shell's arrangement: that file
    // has no assets block of its own, so a `/id="fish-assets"/` search returns
    // 597 KB of JavaScript where the build expects a JSON payload
    const decoyFirst = [trap.split("\n")[2], trap.split("\n")[0], trap.split("\n")[1]].join("\n");
    const naive = /<script\s+id=["']fish-assets["'][^>]*>([\s\S]*?)<\/script>/i.exec(decoyFirst)![1];
    expect(() => JSON.parse(naive)).toThrow();
    const real = elements(decoyFirst, "script").find((el) => el.id === "fish-assets")!;
    expect(JSON.parse(real.text)).toEqual({ real: "asset" });
  });

  it("leaves the built document with no decoy left to find", () => {
    if (!statSync(SHELL, { throwIfNoEntry: false })) return;
    // b86 cannot spell `<script id="`, so the copies inside the bundle are gone
    const built = demoFixtureHtml(readFileSync(SHELL, "utf-8"));
    expect((built.match(/id="fish-assets"/g) ?? []).length).toBe(1);
    expect((built.match(/id="design-doc"/g) ?? []).length).toBe(1);
  });
});