import fs from "node:fs";
import path from "node:path";
import { compactDocumentJson, documentJson } from "../document-json";
import { normalizeDesignDocument } from "../dsl/normalize";
import { parseLenientJson } from "../dsl/lenient-json";
import { createId } from "../id";
import { openverseProvider, lucideProvider, remixProvider } from "../plugins";
import { dataUriBytes, embedImageBytes, embedImageUri, formatBytes } from "./image-embed";
import type { EmbeddedImage } from "./image-embed";
import type { AssetRef, DesignDocument, DesignElement, ImagePaint, Paint } from "../dsl/types";
import { getActivePage, updateActivePageElements } from "../dsl/types";
import { pageRoots, referencedAssetIds } from "../dsl/asset-usage";

const DOC_BLOCK_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;

type DocSource = { file: string; html: boolean; text: string; source: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function readDocSource(file: string): DocSource | string {
  if (!fs.existsSync(file)) return `no such file: ${file}`;
  const source = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) return { file, html: false, text: source, source };
  const match = DOC_BLOCK_RE.exec(source);
  if (!match) return `no #design-doc block in ${file} — not a FISH document`;
  return { file, html: true, text: match[1], source };
}

function writeDocBack(src: DocSource, doc: DesignDocument, outFile?: string, compact = false): string {
  const json = (compact ? compactDocumentJson(doc) : documentJson(doc)).replace(/<\//g, "\\u003c/");
  const target = outFile ?? src.file;
  const targetIsHtml = target.endsWith(".html");
  if (targetIsHtml && src.html) {
    const next = src.source.replace(
      DOC_BLOCK_RE,
      () => `<script id="design-doc" type="application/json">\n${json}\n  </script>`
    );
    fs.writeFileSync(target, next);
  } else {
    fs.writeFileSync(target, json);
  }
  return target;
}

type LoadFailure = { code: number; message: string };
type LoadedDoc = { src: DocSource; doc: DesignDocument };

function isFailure(result: LoadedDoc | LoadFailure): result is LoadFailure {
  return "code" in result;
}

function loadDocument(file: string): LoadedDoc | LoadFailure {
  const src = readDocSource(file);
  if (typeof src === "string") return { code: 2, message: src };
  let raw: unknown;
  try {
    raw = parseLenientJson(src.text.trim() || "{}");
  } catch (err) {
    return { code: 1, message: `${src.file}: the #design-doc block is not valid JSON — ${message(err)}` };
  }
  return { src, doc: normalizeDesignDocument(raw).document };
}

function reportFailure(failure: LoadFailure): number {
  console.error(failure.message);
  return failure.code;
}

/**
 * `./fish compact <doc.fish.html | doc.json> [-o|--out FILE]`
 *
 * Emits the same `compactDocumentJson(doc)` that the workbench's "Copy compact
 * JSON (for agents)" menu item produces: canonicalized, minified, and written
 * with the tree in `pages[]` only while keeping `assets` intact.
 */
export function compactCommand(file: string, opts: { out?: string }): number {
  const src = readDocSource(file);
  if (typeof src === "string") {
    console.error(src);
    return 2;
  }
  let raw: unknown;
  try {
    raw = parseLenientJson(src.text.trim() || "{}");
  } catch (err) {
    console.error(`${src.file}: the #design-doc block is not valid JSON — ${message(err)}`);
    return 1;
  }
  const { document } = normalizeDesignDocument(raw);
  const compact = compactDocumentJson(document);

  if (opts.out) {
    if (opts.out.endsWith(".html") && src.html) {
      writeDocBack(src, document, opts.out, true);
    } else {
      fs.writeFileSync(opts.out, compact);
    }
    console.log(`wrote compact JSON to ${opts.out} (${compact.length} bytes)`);
    return 0;
  }

  console.log(compact);
  return 0;
}

export interface AssetsCommandOpts {
  json: boolean;
  source?: string;
  limit?: number;
  addTo?: string;
  pick?: number;
  embed?: boolean;
  id?: string;
  all?: boolean;
  name?: string;
  to?: string;
  replace?: boolean;
}

/**
 * `./fish assets <doc.fish.html | doc.json> [--json]`
 * `./fish assets search <query> [--source openverse|lucide|ri] [--limit N] [--add-to <doc>] [--pick N] [--embed] [--to <id>] [--replace] [--json]`
 * `./fish assets import <file...> <doc.fish.html> [--name N] [--to <id>] [--replace]`
 * `./fish assets embed <doc.fish.html> (--id <assetId> | --all)`
 */
export async function assetsCommand(args: string[], opts: AssetsCommandOpts): Promise<number> {
  if (args.length === 0) {
    console.error(
      'assets needs a document path, or "search <query>", or "import <file> <doc>", or "embed <doc>" ' +
        "(e.g. `./fish assets design.fish.html` or `./fish assets search \"coffee\" --source openverse`)"
    );
    return 2;
  }

  if (args[0] === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      console.error('assets search needs a query string (e.g. `./fish assets search "minimalist chair"`)');
      return 2;
    }
    return searchAssets(query, opts);
  }

  if (args[0] === "import") return assetsImportCommand(args.slice(1), opts);
  if (args[0] === "embed") return assetsEmbedCommand(args.slice(1), opts);

  return listDocumentAssets(args[0], opts);
}

/**
 * What an asset `uri` can be fetched as. Only http(s) is: `assets embed` goes
 * through `fetch`, which reads a URL and not a path, and the two failures a
 * local path produces (`ERR_INVALID_URL` for a relative one, "not implemented"
 * for `file://`) say nothing about the command that would have worked.
 */
const isFetchableUri = (uri: string): boolean => /^https?:\/\//i.test(uri);

function listDocumentAssets(file: string, opts: AssetsCommandOpts): number {
  const loaded = loadDocument(file);
  if (isFailure(loaded)) return reportFailure(loaded);
  const { src, doc } = loaded;

  const assets = (doc.assets ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    width: a.width,
    height: a.height,
    kind: a.uri?.startsWith("data:")
      ? "embedded-data-uri"
      : a.uri && isFetchableUri(a.uri)
        ? "remote-url"
        : "unfetchable (a local path — `assets import` is how those get in)",
    bytes: a.uri ? dataUriBytes(a.uri) : null,
    credit: a.credit
  }));
  const embeddedBytes = assets.reduce((sum, a) => sum + (a.bytes ?? 0), 0);

  if (opts.json) {
    console.log(JSON.stringify({ file: src.file, count: assets.length, embeddedBytes, assets }, null, 2));
    return 0;
  }

  console.log(`${src.file} · ${assets.length} asset(s) in doc.assets`);
  if (assets.length === 0) {
    console.log('  none — ask the user for brand/product assets or run `./fish assets search "<query>" --add-to ' + src.file + "`");
    return 0;
  }
  for (const a of assets) {
    const dim = a.width && a.height ? `${a.width}×${a.height}` : "unmeasured";
    const size = a.bytes === null ? "remote" : formatBytes(a.bytes);
    const credit = a.credit?.name ? ` · ${a.credit.name}` : "";
    console.log(`  ${a.id.padEnd(20)} ${a.name} (${dim}, ${a.kind} · ${size}${credit})`);
  }
  console.log(`  embedded total ${formatBytes(embeddedBytes)} (${fs.statSync(src.file).size} bytes on disk)`);
  return 0;
}

/**
 * `--to <elementId>`: put the asset on a shape in the same run that registered
 * it.
 *
 * An asset id is minted per run, so without this the author has to read a random
 * id out of one command and paste it into an `apply` — and until that second
 * command runs, the document carries bytes nothing points at.
 *
 * The fill is APPENDED by default: `fills` paints bottom-first, so the new layer
 * sits on top of whatever the shape already had, which is what a placeholder
 * colour under a photograph expects. `replace` is the other job — swapping the
 * photograph — and drops the image layers already there so a second import does
 * not leave two photos stacked with the first one's bytes still in the file.
 * Returns null when the id names nothing, so the caller can refuse before
 * writing rather than leave a half-applied document.
 */
export function bindAssetFill(
  doc: DesignDocument,
  elementId: string,
  fill: ImagePaint,
  mode: "append" | "replace" = "append"
): DesignDocument | null {
  let found = false;
  const walk = (els: DesignElement[]): DesignElement[] =>
    els.map((el) => {
      if (el.id === elementId) {
        found = true;
        const existing = ((el as { fills?: Paint[] }).fills ?? []);
        const kept = mode === "replace" ? existing.filter((paint) => paint?.type !== "image") : existing;
        const withFill = { ...el, fills: [...kept, fill] } as DesignElement;
        return withFill;
      }
      const children = (el as { children?: DesignElement[] }).children;
      if (!children) return el;
      return { ...el, children: walk(children) } as DesignElement;
    });
  const elements = walk(getActivePage(doc).children ?? []);
  return found ? updateActivePageElements(doc, elements) : null;
}

/** The assets an element's image layers point at — what `--replace` is about to drop. */
export function imageAssetIdsOn(doc: DesignDocument, elementId: string): string[] {
  const ids: string[] = [];
  const walk = (els: DesignElement[] | undefined) => {
    for (const el of els ?? []) {
      if (el.id === elementId) {
        for (const paint of ((el as { fills?: Paint[] }).fills ?? [])) {
          if (paint?.type === "image" && typeof (paint as ImagePaint).assetId === "string") {
            ids.push((paint as ImagePaint).assetId as string);
          }
        }
      }
      walk((el as { children?: DesignElement[] }).children);
    }
  };
  walk(pageRoots(doc));
  return ids;
}

/** Drop the named assets if nothing in the document references them any more. */
export function dropUnreferencedAssets(doc: DesignDocument, candidates: string[]): { doc: DesignDocument; dropped: string[] } {
  if (candidates.length === 0) return { doc, dropped: [] };
  const used = referencedAssetIds(doc);
  const dropped = [...new Set(candidates)].filter((id) => !used.has(id));
  if (dropped.length === 0) return { doc, dropped };
  return { doc: { ...doc, assets: (doc.assets ?? []).filter((a) => !dropped.includes(a.id)) }, dropped };
}

/**
 * `assets import` — a file on this machine becomes an asset in the document.
 *
 * The bytes are embedded rather than referenced because a document that points
 * at a local path renders as an empty box on every machine but this one, which
 * is the same failure as a remote URL and harder to notice.
 *
 * Several files in one run write the document once. Registering them one at a
 * time rewrites the whole `#design-doc` block per file, so a batch of ten photos
 * copies the document's existing megabytes ten times over — the cost is the
 * rewrite, not the decode.
 *
 * Every file is embedded before anything is written: a local file either reads or
 * it does not, and a half-registered batch is a document whose assets[] depends
 * on which argument failed.
 */
async function assetsImportCommand(rest: string[], opts: AssetsCommandOpts): Promise<number> {
  const docFile = rest[rest.length - 1];
  const files = rest.slice(0, -1);
  if (files.length === 0 || !docFile) {
    console.error("assets import needs a source file and a document (e.g. `fish assets import ./hero.jpg design.fish.html`)");
    return 2;
  }
  if (files.length > 1 && opts.name) {
    console.error(`--name names one file, but ${files.length} were given — drop it and each file is named after its basename`);
    return 2;
  }
  if (files.length > 1 && opts.to) {
    console.error(`--to fills one element, but ${files.length} files were given — import them first, then bind each with an apply`);
    return 2;
  }
  if (opts.replace && !opts.to) {
    console.error("--replace needs --to <elementId> — it swaps the image on an element, it does not edit assets[] on its own");
    return 2;
  }
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`no such file: ${file}`);
      return 2;
    }
  }
  const loaded = loadDocument(docFile);
  if (isFailure(loaded)) return reportFailure(loaded);

  const imported: { asset: AssetRef; bytes: number; sourceBytes: number }[] = [];
  for (const file of files) {
    const name = opts.name ?? path.basename(file).replace(/\.[^/.]+$/, "");
    try {
      const embedded = await embedImageBytes(new Uint8Array(fs.readFileSync(file)), null, name);
      imported.push({
        asset: {
          id: createId("asset"),
          name,
          uri: embedded.uri,
          width: embedded.width,
          height: embedded.height
        },
        bytes: embedded.bytes,
        sourceBytes: fs.statSync(file).size
      });
    } catch (err) {
      console.error(`import failed for ${file}: ${message(err)}`);
      console.error(`  nothing was written — the document still has its previous assets`);
      return 1;
    }
  }

  const [first] = imported;
  const fill = { type: "image", assetId: first.asset.id, fit: "cover" } as ImagePaint;
  const replacedAssets = opts.to && opts.replace ? imageAssetIdsOn(loaded.doc, opts.to) : [];
  const registered: DesignDocument = {
    ...loaded.doc,
    assets: [...(loaded.doc.assets ?? []), ...imported.map((entry) => entry.asset)]
  };
  const bound = opts.to ? bindAssetFill(registered, opts.to, fill, opts.replace ? "replace" : "append") : registered;
  if (!bound) {
    console.error(`no element "${opts.to}" in ${loaded.src.file} — nothing was written`);
    return 2;
  }
  const { doc: next, dropped } = dropUnreferencedAssets(bound, replacedAssets);

  const before = fs.statSync(loaded.src.file).size;
  writeDocBack(loaded.src, next);
  const after = fs.statSync(loaded.src.file).size;
  const assetBytes = imported.reduce((sum, entry) => sum + entry.bytes, 0);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          file: loaded.src.file,
          assets: imported.map((entry) => entry.asset),
          // Kept for the single-file case: agents that parse this have been
          // reading `asset` since before a batch could exist.
          ...(imported.length === 1 ? { asset: imported[0].asset } : {}),
          fill: opts.to ? fill : null,
          boundTo: opts.to ?? null,
          replaced: Boolean(opts.replace),
          droppedAssets: dropped,
          sourceBytes: imported.reduce((sum, entry) => sum + entry.sourceBytes, 0),
          assetBytes,
          before,
          after
        },
        null,
        2
      )
    );
    return 0;
  }
  console.log(
    `added ${imported.length} asset(s) to ${loaded.src.file}: ` +
      imported.map((entry) => `"${entry.asset.id}" (${entry.asset.name})`).join(", ")
  );
  console.log(`  ${formatBytes(assetBytes)} embedded · document ${formatBytes(before)} → ${formatBytes(after)}`);
  if (opts.to) console.log(`  ${opts.replace ? "replaced the image on" : "filled"} "${opts.to}" with: ${JSON.stringify(fill)}`);
  else console.log(`  use in fills: ${JSON.stringify(fill)}`);
  if (dropped.length > 0) console.log(`  dropped ${dropped.length} replaced asset(s): ${dropped.join(", ")}`);
  return 0;
}

/** Fetch the first URL that answers, so a dead `src` can still fall back to the provider proxy. */
async function embedFirstAvailable(uris: (string | undefined)[], name: string): Promise<EmbeddedImage> {
  const tried = new Set<string>();
  let lastError: unknown = null;
  for (const uri of uris) {
    if (!uri || tried.has(uri)) continue;
    tried.add(uri);
    try {
      return await embedImageUri(uri, name);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("no URL to fetch");
}

/**
 * `assets embed` — remote assets already in the document become embedded ones.
 *
 * The asset `id` is preserved, which is the whole reason this can be done in
 * place: elements point at assets by `assetId`, so minting a new id here would
 * blank every fill that used the old one.
 *
 * One bad URL does not abandon the run — the assets that resolved are written
 * and the ones that did not stay remote, because a document with four of five
 * images embedded is strictly better than one with none.
 */
async function assetsEmbedCommand(rest: string[], opts: AssetsCommandOpts): Promise<number> {
  const docFile = rest[0];
  if (!docFile) {
    console.error("assets embed needs a document (e.g. `fish assets embed design.fish.html --all`)");
    return 2;
  }
  if (!opts.id && !opts.all) {
    console.error("assets embed needs --id <assetId> or --all — nothing is embedded by accident");
    return 2;
  }
  const loaded = loadDocument(docFile);
  if (isFailure(loaded)) return reportFailure(loaded);

  const assets = loaded.doc.assets ?? [];
  const selected = opts.all ? assets : assets.filter((a) => a.id === opts.id);
  if (opts.id && selected.length === 0) {
    console.error(`no asset "${opts.id}" in ${loaded.src.file}`);
    return 2;
  }
  const targets = selected.filter((a) => a.uri && !a.uri.startsWith("data:"));
  if (targets.length === 0) {
    console.log(
      selected.length === 0
        ? `${loaded.src.file} has no assets`
        : `all ${selected.length} selected asset(s) are already embedded — nothing to do`
    );
    return 0;
  }

  const next = [...assets];
  const outcomes: { id: string; ok: boolean; detail: string }[] = [];
  for (const asset of targets) {
    const at = next.findIndex((a) => a.id === asset.id);
    if (!asset.uri || !isFetchableUri(asset.uri)) {
      outcomes.push({
        id: asset.id,
        ok: false,
        detail: `"${asset.uri}" is not a URL — embed fetches over http(s); a file on this machine goes through "assets import <file> <doc>"`
      });
      continue;
    }
    try {
      const embedded = await embedFirstAvailable([asset.uri], asset.name);
      next[at] = { ...asset, uri: embedded.uri, width: embedded.width, height: embedded.height };
      outcomes.push({
        id: asset.id,
        ok: true,
        detail: `${embedded.mime} ${embedded.width}×${embedded.height} · ${formatBytes(embedded.bytes)}`
      });
    } catch (err) {
      outcomes.push({ id: asset.id, ok: false, detail: message(err) });
    }
  }

  const changed = outcomes.some((o) => o.ok);
  const before = fs.statSync(loaded.src.file).size;
  if (changed) writeDocBack(loaded.src, { ...loaded.doc, assets: next });
  const after = fs.statSync(loaded.src.file).size;
  const failed = outcomes.filter((o) => !o.ok);

  if (opts.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, file: loaded.src.file, outcomes, before, after }, null, 2));
    return failed.length === 0 ? 0 : 1;
  }

  console.log(`${loaded.src.file} · ${targets.length} remote asset(s)`);
  for (const o of outcomes) console.log(`  ${o.ok ? "ok  " : "FAIL"} ${o.id} — ${o.detail}`);
  if (changed) console.log(`  document ${formatBytes(before)} → ${formatBytes(after)}`);
  if (failed.length > 0) console.log(`  ${failed.length} asset(s) left as remote URLs`);
  return failed.length === 0 ? 0 : 1;
}

async function searchAssets(query: string, opts: AssetsCommandOpts): Promise<number> {
  const source = (opts.source ?? "openverse").toLowerCase();
  const limit = opts.limit && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(20, Math.floor(opts.limit)) : 5;

  if (source === "lucide" || source === "ri" || source === "remix") {
    const provider = source === "lucide" ? lucideProvider : remixProvider;
    const results = await provider.search(query, limit);
    const elements = results.map((r) => {
      const inserted = provider.insert(r, { x: 0, y: 0 });
      return Promise.resolve(inserted).then((res) => ({
        id: r.id,
        name: r.name,
        element: res.element,
        credit: r.credit
      }));
    });
    const resolved = await Promise.all(elements);
    if (opts.json) {
      console.log(JSON.stringify({ source: provider.id, query, count: resolved.length, results: resolved }, null, 2));
      return 0;
    }
    console.log(`${provider.name} · ${resolved.length} match(es) for "${query}"`);
    for (const [idx, item] of resolved.entries()) {
      console.log(`  [${idx}] ${item.id} (${item.name}) — 24×24 path:`);
      console.log(`      ${JSON.stringify(item.element)}`);
    }
    return 0;
  }

  if (source !== "openverse") {
    console.error(`unknown asset source "${source}" (supported: openverse, lucide, ri)`);
    return 2;
  }

  let results;
  try {
    results = await openverseProvider.search(query, limit);
  } catch (err) {
    console.error(`openverse search failed: ${message(err)}`);
    return 1;
  }

  if (results.length === 0) {
    if (opts.json) console.log(JSON.stringify({ source: "openverse", query, count: 0, results: [] }, null, 2));
    else console.log(`Openverse · 0 matches for "${query}"`);
    return 0;
  }

  if (opts.addTo) {
    const loaded = loadDocument(opts.addTo);
    if (isFailure(loaded)) return reportFailure(loaded);

    const pickIdx = opts.pick && Number.isFinite(opts.pick) && opts.pick >= 0 ? Math.min(results.length - 1, Math.floor(opts.pick)) : 0;
    const chosen = results[pickIdx];

    let asset: AssetRef;
    if (opts.embed) {
      let embedded: EmbeddedImage;
      try {
        embedded = await embedFirstAvailable([chosen.src, chosen.preview], chosen.name);
      } catch (err) {
        console.error(`could not embed "${chosen.name}": ${message(err)}`);
        console.error("  nothing was written — the document still has its previous assets");
        return 1;
      }
      asset = {
        id: createId("asset"),
        name: chosen.name,
        uri: embedded.uri,
        width: embedded.width,
        height: embedded.height,
        ...(chosen.credit ? { credit: { name: chosen.credit.name, url: chosen.credit.url } } : {})
      };
      if (!opts.json) {
        console.log(
          `  embedded ${embedded.mime} ${embedded.width}×${embedded.height} · ${formatBytes(embedded.bytes)}`
        );
      }
    } else {
      asset = {
        id: createId("asset"),
        name: chosen.name,
        uri: chosen.src || chosen.preview || "",
        ...(chosen.width ? { width: chosen.width } : {}),
        ...(chosen.height ? { height: chosen.height } : {}),
        ...(chosen.credit ? { credit: { name: chosen.credit.name, url: chosen.credit.url } } : {})
      };
    }

    const fill = { type: "image", assetId: asset.id, fit: "cover" } as ImagePaint;
    const replacedAssets = opts.to && opts.replace ? imageAssetIdsOn(loaded.doc, opts.to) : [];
    const registered: DesignDocument = { ...loaded.doc, assets: [...(loaded.doc.assets ?? []), asset] };
    const bound = opts.to ? bindAssetFill(registered, opts.to, fill, opts.replace ? "replace" : "append") : registered;
    if (!bound) {
      console.error(`no element "${opts.to}" in ${loaded.src.file} — nothing was written`);
      return 2;
    }
    const { doc: next, dropped } = dropUnreferencedAssets(bound, replacedAssets);

    const before = fs.statSync(loaded.src.file).size;
    writeDocBack(loaded.src, next);
    const after = fs.statSync(loaded.src.file).size;
    if (opts.json) {
      console.log(
        JSON.stringify(
          { ok: true, file: loaded.src.file, asset, fill, boundTo: opts.to ?? null, replaced: Boolean(opts.replace), droppedAssets: dropped, before, after },
          null,
          2
        )
      );
    } else {
      console.log(`added asset "${asset.id}" (${asset.name}) to ${loaded.src.file}`);
      console.log(`  document ${formatBytes(before)} → ${formatBytes(after)}`);
      console.log(opts.to ? `  ${opts.replace ? "replaced the image on" : "filled"} "${opts.to}" with: ${JSON.stringify(fill)}` : `  use in fills: ${JSON.stringify(fill)}`);
      if (dropped.length > 0) console.log(`  dropped ${dropped.length} replaced asset(s): ${dropped.join(", ")}`);
    }
    return 0;
  }

  if (opts.json) {
    console.log(JSON.stringify({ source: "openverse", query, count: results.length, results }, null, 2));
    return 0;
  }

  console.log(`Openverse · ${results.length} match(es) for "${query}"`);
  for (const [idx, r] of results.entries()) {
    const dim = r.width && r.height ? `${r.width}×${r.height}` : "unmeasured";
    const by = r.credit?.name ? ` · Photo by ${r.credit.name}` : "";
    console.log(`  [${idx}] ${r.name} (${dim}${by})`);
    console.log(`      uri: ${r.src || r.preview}`);
  }
  console.log(
    `\n  Tip: add directly to a document with \`./fish assets search "${query}" --add-to <doc.fish.html> [--pick 0]\`\n` +
      "       add `--embed` to write the bytes into the document instead of a link, so it opens offline"
  );
  return 0;
}

/**
 * Automatically embeds local files declared in `doc.assets[]`.
 *
 * Supports `file`, `path`, or local file in `src`/`uri`.
 */
export async function embedLocalDocumentAssets(
  doc: unknown,
  baseDir: string
): Promise<{ count: number; error?: string }> {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { count: 0 };
  const assets = (doc as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return { count: 0 };

  let count = 0;
  for (const item of assets) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const rawFile =
      typeof rec.file === "string" && rec.file.trim()
        ? rec.file.trim()
        : typeof rec.path === "string" && rec.path.trim()
          ? rec.path.trim()
          : typeof rec.src === "string" && rec.src.trim() && !isFetchableUri(rec.src.trim()) && !rec.src.trim().startsWith("data:")
            ? rec.src.trim()
            : typeof rec.uri === "string" && rec.uri.trim() && !isFetchableUri(rec.uri.trim()) && !rec.uri.trim().startsWith("data:")
              ? rec.uri.trim()
              : null;

    if (!rawFile) continue;

    const resolved = path.isAbsolute(rawFile) ? rawFile : path.resolve(baseDir, rawFile);
    if (!fs.existsSync(resolved)) {
      return {
        count,
        error: `asset "${String(rec.id ?? "unknown")}": local file not found: ${rawFile} (resolved to ${resolved})`
      };
    }

    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : path.basename(resolved).replace(/\.[^/.]+$/, "");
    try {
      const bytes = new Uint8Array(fs.readFileSync(resolved));
      const embedded = await embedImageBytes(bytes, null, name);
      rec.uri = embedded.uri;
      if (rec.width === undefined && embedded.width > 0) rec.width = embedded.width;
      if (rec.height === undefined && embedded.height > 0) rec.height = embedded.height;
      if (rec.name === undefined) rec.name = name;
      delete rec.file;
      delete rec.path;
      count++;
    } catch (err) {
      return {
        count,
        error: `asset "${String(rec.id ?? "unknown")}": failed to embed ${rawFile} — ${err instanceof Error ? err.message : err}`
      };
    }
  }

  return { count };
}

