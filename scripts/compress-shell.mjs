// Turns the vite output into the shell that ships: the runtime bundle and the
// stylesheet ride along as raw-DEFLATE + base86 payload blocks, and a loader
// rebuilds them synchronously before the parser reaches the end of <body>.
//
// What stays plaintext, and has to:
//   - <script id="design-doc">  the document. Every other surface in the product
//     treats it as the one hand-editable part of the file: the agent kit, the AI
//     `fish compose` patch path, `scripts/reshell.mjs`, and every regex in
//     src/core/data-bridge.ts that finds the document by its id.
//   - <script id="fish-assets"> likewise.
//   - any <style> without rel="stylesheet" — the reset block in index.html is 423
//     bytes and carries the page background. Dropping it leaves a transparent
//     body behind a document that sets its own colours.
//
// Usage: node scripts/compress-shell.mjs [file ...]   (default: dist/index.html).
// Run after `vite build`, before scripts/build-fish-agent-kit.mjs copies the
// shell into the agent kit, or the kit ships the uncompressed one.

import { readFileSync, writeFileSync } from "node:fs";
import { minify } from "terser";
import { resolve } from "node:path";
import { deflateAsync as zopfliDeflateRaw } from "@gfx/zopfli";
import { encode, decode, FORBIDDEN, LOADER_DECODER } from "./lib/b86.mjs";
import { inflateRaw } from "./lib/inflate-raw.js";
// Shared with `reshell.mjs`: the walker that knows a `<script` inside the
// document JSON is text, not an element with a source span.
import { scanElements, blockById } from "./lib/html-blocks.mjs";

const DEFAULT_TARGETS = ["dist/index.html"];

// A build-time trade, not a runtime one: deflate's format is fixed by RFC 1951, but
// how the LZ77 matches are found is not, and zlib's level 9 stops at the first good
// match to finish in milliseconds. Zopfli re-plans the whole stream over several
// passes for a few seconds and lands ~4% smaller, still plain raw DEFLATE — which is
// why the inlined `inflateRaw` below and every decoder that ships stay untouched.
async function pack(text) {
  const source = Buffer.from(text, "utf-8");
  const deflated = Buffer.from(await zopfliDeflateRaw(source, { numiterations: 15 }));
  const payload = encode(deflated);
  const roundTripped = Buffer.from(decode(payload));
  if (Buffer.compare(roundTripped, deflated) !== 0) throw new Error("b86 round trip failed");
  const inflated = Buffer.from(inflateRaw(deflated));
  if (Buffer.compare(inflated, source) !== 0) throw new Error("inflate round trip failed");
  // The loader can only count UTF-16 code units, and the bundle is not ASCII:
  // UTF-8 bytes outnumber code units wherever it carries an em dash or a Chinese
  // label, so `data-chars` counts characters and never bytes.
  return { source, chars: text.length, deflated, payload };
}

async function loader() {
  const inflateSource = readFileSync(new URL("./lib/inflate-raw.js", import.meta.url), "utf-8")
    .replace(/\bexport\s+/g, "")
    .trim();
  const unminified = `(function(){
${inflateSource}
${LOADER_DECODER}
  // A file written by a build that did not truncate carries a second copy of this
  // loader after the real one. Booting twice mounts the runtime over itself, and a
  // decode failure in the copy paints its error text into the #app the first one
  // already rendered — a working document replaced by "could not be unpacked".
  // The mark is a property of the Document, not an attribute: anything in the DOM
  // is cloned into the pristine shell and would be saved back into every file.
  if(document.__fishBooted)return;
  document.__fishBooted=1;
  function fail(reason){
    // The cover is cleared FIRST: it is a full-window overlay, and a file that
    // cannot boot has to show why instead of a picture of what it should be.
    var covers=document.querySelectorAll("[data-fish-preview]");
    for(var c=covers.length;c--;)covers[c].remove();
    var host=document.getElementById("app");
    if(host)host.textContent="This FISH file could not be unpacked: "+reason;
    console.error("[fish] shell decode failed:",reason);
  }
  // A save written by an older build, or one interrupted mid-write, can carry the
  // rebuilt runtime as live <style>/<script> elements. Re-injecting a second copy
  // mounts React over React; drop the stale ones before decoding.
  var stale=document.querySelectorAll("[data-fish-transient]");
  for(var i=0;i<stale.length;i++)stale[i].remove();
  try{
    var blocks=document.querySelectorAll('script[type="fish/deflate-b86"]'),styles=[],runtime=null,failure=null;
    for(var b=0;b<blocks.length;b++){
      var block=blocks[b],bytes,text;
      // One unreadable payload is not a reason to refuse the file: a later copy of
      // the same block may still be whole. Only having none is fatal.
      try{
        bytes=fishB86Decode(block.textContent);
        text=new TextDecoder("utf-8",{fatal:true}).decode(inflateRaw(bytes));
        // deflate carries neither a length nor a checksum, so a truncated payload can
        // decode to a shorter stream that still ends on a final block. The character
        // count the build recorded is the only witness left.
        if(Number(block.getAttribute("data-chars"))!==text.length)throw new Error("payload length mismatch in #"+block.id);
      }catch(err){if(!failure)failure=err;continue}
      if(block.id.indexOf("fish-rt-css")===0)styles.push(text);
      else if(!runtime)runtime=text;
    }
    if(!runtime)throw failure||new Error("no runtime payload");
    for(var s=0;s<styles.length;s++){
      var style=document.createElement("style");
      style.setAttribute("data-fish-transient","");
      style.textContent=styles[s];
      document.head.appendChild(style);
    }
    var script=document.createElement("script");
    script.setAttribute("data-fish-transient","");
    script.textContent=runtime;
    document.body.appendChild(script);
  }catch(err){fail(err&&err.message?err.message:String(err))}
})();
`;
  // Terser cuts the loader from ~10.5 KB to a third of that, on every build, and
  // `module: false` keeps it from assuming the module scope it will never run in.
  const { code } = await minify(unminified, { module: false, compress: { passes: 3 }, mangle: true });
  // A loader that cannot even parse is a blank page for every user, so the build
  // refuses to emit one.
  new Function(code);
  return code;
}

async function compressFile(file) {
  const original = readFileSync(file, "utf-8");
  const elements = [...scanElements(original)];
  const scripts = elements.filter((el) => el.tag === "script" && el.attr("type") === "module");
  const styles = elements.filter((el) => el.tag === "style" && el.attr("rel") === "stylesheet");
  if (scripts.length === 0 && original.includes('type="fish/deflate-b86"')) {
    throw new Error(`${file}: already compressed — run \`npm run build\`, not this script alone`);
  }
  if (scripts.length !== 1) throw new Error(`${file}: expected 1 module script, found ${scripts.length}`);
  if (styles.length === 0) throw new Error(`${file}: no linked stylesheet to pack`);

  const js = await pack(scripts[0].text);
  const css = await Promise.all(styles.map((el) => pack(el.text)));
  const loaderSource = await loader();

  const block = (id, item) =>
    `<script id="${id}" type="fish/deflate-b86" data-chars="${item.chars}">${item.payload}</script>`;
  const body = [block("fish-rt-css", css[0]), ...styles.slice(1).map((el, i) => block(`fish-rt-css-${i + 1}`, el))]
    .join("\n") +
    `\n${block("fish-rt", js)}` +
    `\n<script>${loaderSource}</script>`;

  const spans = [...styles, ...scripts].sort((a, b) => b.start - a.start);
  let shell = original;
  for (const span of spans) {
    shell = shell.slice(0, span.start) + shell.slice(span.end);
  }
  const bodyClose = shell.lastIndexOf("</body>");
  if (bodyClose < 0) throw new Error(`${file}: no </body>`);
  shell = shell.slice(0, bodyClose) + body + "\n  " + shell.slice(bodyClose);

  verify(file, shell, original, [js, ...css]);

  const after = Buffer.byteLength(shell);

  writeFileSync(file, shell);
  return {
    file,
    before: Buffer.byteLength(original),
    after,
    js: [js.source.length, js.deflated.length, js.payload.length],
    css: css.map((c) => [c.source.length, c.deflated.length, c.payload.length]),
    loader: loaderSource.length
  };
}

function verify(file, shell, original, packed) {
  // A browser ends an element at the first `</script` in the file, wherever it
  // appears — inside a JS string or comment included. So the count of that literal
  // has to equal the count of real elements, and the real count comes from the
  // walker: the uncompressed bundle alone spells `<script` seven times as text.
  for (const tag of ["script", "style"]) {
    const elements = [...scanElements(shell)].filter((el) => el.tag === tag).length;
    const closes = (shell.match(new RegExp(`</${tag}`, "gi")) ?? []).length;
    if (elements !== closes) {
      throw new Error(`${file}: ${elements} <${tag}> elements but ${closes} </${tag}> markers`);
    }
  }

  for (const { payload, source, deflated } of packed) {
    for (const needle of FORBIDDEN) {
      if (payload.includes(needle)) throw new Error(`${file}: payload spells ${needle}`);
    }
    // the exact path the loader runs in the browser, with this repo's decoder
    const rebuilt = new TextDecoder().decode(inflateRaw(decode(payload)));
    if (Buffer.compare(Buffer.from(rebuilt, "utf-8"), source) !== 0) {
      throw new Error(`${file}: loader path does not reproduce the original`);
    }
    if (!deflated.length) throw new Error(`${file}: empty deflate stream`);
  }

  // Both blocks are load-bearing for the product's write-back, CLI patch and
  // reshell paths, so the build refuses to emit a shell that moved either one.
  // The naive `/id="fish-assets"/` regex finds the bundle's own template literal
  // for the string and reads 597 KB of JavaScript as the block.
  for (const id of ["design-doc", "fish-assets"]) {
    const before = blockById(original, id);
    const after = blockById(shell, id);
    if (!before) continue;
    if (before.text !== after?.text) throw new Error(`${file}: the #${id} block changed`);
  }
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
for (const target of targets) {
  const report = await compressFile(resolve(target));
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(
    `${report.file}\n` +
    `  shell      ${kb(report.before)} → ${kb(report.after)}  (${((1 - report.after / report.before) * 100).toFixed(1)}% smaller)\n` +
    `  js         ${kb(report.js[0])} → deflate ${kb(report.js[1])} → b86 ${kb(report.js[2])}\n` +
    report.css.map((c, i) => `  css${i}       ${kb(c[0])} → deflate ${kb(c[1])} → b86 ${kb(c[2])}`).join("\n") +
    `\n  loader     ${kb(report.loader)}`
  );
}