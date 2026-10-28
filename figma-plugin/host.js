/**
 * FISH Export — the sandbox half.
 *
 * Its whole job is to walk the document in memory and post the result to the UI
 * iframe, which is the only half that can write a file — or reach the clipboard,
 * which is the same envelope travelling as text instead of as a zip. Everything
 * that decides what a Figma node MEANS happens in `collect.js`, and everything
 * that decides what the import COSTS happens in `src/core/import/figma-*.ts`;
 * this file makes no mapping and no downgrade decision, because a second opinion
 * about either is how the two import paths start disagreeing
 * (`docs/LESSONS_LEARNED.md` §142).
 *
 * `documentAccess: "dynamic-page"` is mandatory for new plugins and it shapes
 * this file in three ways, all of them load-bearing:
 *
 *   1. `figma.getNodeById` THROWS. `getNodeByIdAsync` is the only way in.
 *   2. `instance.mainComponent` is WRITE-ONLY. `getMainComponentAsync` is the read.
 *   3. Pages are not loaded until asked. Walking a page the plugin never loaded
 *      yields an empty tree, which reads as "the export lost two pages" rather
 *      than as an error — so `loadAllPagesAsync` is awaited before any traversal.
 */

figma.showUI(__html__, { width: 380, height: 460, themeColors: true });

/**
 * The last clipboard copy, as TEXT.
 *
 * Kept for one reason: the UI's receiver asks for a piece that never arrived,
 * and it asks AFTER `runCopy` has returned. The file path has no such memory —
 * its archive is a local — so this is the copy's half of the transport's
 * ask-and-resend contract (`bundle.js`), and 8MB is the most it can ever hold.
 */
var lastCopy = null;

/**
 * What each scope exports, as GIGO PAGES rather than as loose nodes.
 *
 * A group is `{ id, name, nodes, backgroundColor }` — the page, and what sits on
 * it. The page node itself is deliberately NOT in `nodes`: a `PageNode` has no
 * `absoluteBoundingBox`, so the shim emits it with no box and the app drops it
 * together with everything under it. That is not a hypothetical — it is what a
 * real export did, arriving as a document with no layers at all.
 */
var SCOPES = {
  selection: function () {
    return [pageGroup(figma.currentPage, figma.currentPage.selection.slice())];
  },
  page: function () {
    return [pageGroup(figma.currentPage, figma.currentPage.children.slice())];
  },
  file: function () {
    return figma.root.children.map(function (page) {
      return pageGroup(page, page.children.slice());
    });
  }
};

/** One Figma page and its content, in the shape `buildExport` consumes. */
function pageGroup(page, nodes) {
  return { id: page.id, name: page.name, nodes: nodes, backgroundColor: pageBackground(page) };
}

figma.ui.onmessage = async function (message) {
  var msg = message || {};
  try {
    if (msg.type === "scopes") {
      figma.ui.postMessage(await describeScopes());
      return;
    }
    if (msg.type === "export") {
      await runExport(msg.scope, msg.images !== false);
      return;
    }
    if (msg.type === "copy") {
      figma.ui.postMessage(await runCopy(msg.scope, msg.images !== false));
      return;
    }
    if (msg.type === "archive-need" && lastCopy !== null) {
      // A piece of the copy the iframe never got, asked for by offset. Re-sent
      // from there, exactly as `postArchive`'s `from` is for.
      postArchive(function (message) { figma.ui.postMessage(message); }, utf8(lastCopy), 0, msg.from || 0, POST_CHUNK, "copied");
      return;
    }
    if (msg.type === "close") {
      figma.closePlugin();
    }
  } catch (err) {
    figma.ui.postMessage({ type: "failed", message: String((err && err.message) || err) });
  }
};

/**
 * Materialise the nodes a scope names.
 *
 * Loading every page is the price of `dynamic-page`, and it is paid here rather
 * than per-scope: a selection lives on the current page, but a node's component
 * may live on another one, and the page-level scope is the same walk with a
 * different root.
 */
async function resolveScope(scope) {
  if (scope === "file") await figma.loadAllPagesAsync();
  else if (figma.root.children.length > 1) await figma.loadAllPagesAsync();

  // In Figma Slides the page's children are the SLIDE GRID, and the slides sit
  // two levels below it. Handing the grid over as one root would export the deck
  // as a single enormous nested frame, which imports as a design with one layer
  // rather than as a deck with N — so the page/file scopes take the SLIDES as
  // their roots, in the grid's own row-major order, and each becomes a top-level
  // element of the exported canvas. That is exactly what the app needs: FISH's
  // presentation reads one slide per top-level container, so a deck lands as a
  // deck without the app being told anything about slides at all.
  if (scope !== "selection" && isSlidesDeck()) return [pageGroup(figma.currentPage, slideRoots())];

  var pick = SCOPES[scope] || SCOPES.selection;
  var groups = pick();
  var total = 0;
  for (var i = 0; i < groups.length; i++) total += groups[i].nodes.length;
  if (total === 0) {
    throw new Error("There is nothing on this page to export — select a frame, or pick another scope.");
  }
  return groups;
}

function isSlidesDeck() {
  if (figma.editorType !== "slides") return false;
  var children = figma.currentPage.children || [];
  for (var i = 0; i < children.length; i++) {
    if (children[i].type === "SLIDE_GRID") return true;
  }
  return false;
}

/**
 * The deck, in order.
 *
 * `getCanvasGrid` is the deck's own reading order — rows top to bottom, and
 * within a row left to right — which is not the same as `findAll`'s tree order
 * and not derivable from geometry once a designer has moved a slide. It is also
 * the only API here that says "these are the slides" rather than "these are the
 * nodes", which is why the empty case below can say what it means.
 */
function slideRoots() {
  if (typeof figma.getCanvasGrid !== "function") return [];
  var grid = figma.getCanvasGrid() || [];
  var slides = [];
  for (var r = 0; r < grid.length; r++) {
    for (var c = 0; c < grid[r].length; c++) {
      var cell = grid[r][c];
      if (cell && cell.type === "SLIDE") slides.push(cell);
    }
  }
  if (slides.length === 0) {
    throw new Error("This deck has no slides to export yet.");
  }
  return slides;
}

/**
 * How big each scope is, before anyone commits to an export.
 *
 * All THREE, every time, rather than the one that is currently picked: the panel
 * shows a count beside every option, and answering only the selected one leaves
 * the other two blank — which reads as "these are empty" rather than as "nobody
 * asked".
 *
 * In a deck the page and file scopes are the SLIDES, so their unit is the slide
 * rather than the layer. Counting layers there would say "5322 layers" for a
 * scope that exports three screens, which is the sort of number that makes a
 * designer hesitate about a file that would have been fine.
 */
async function describeScopes() {
  if (figma.root.children.length > 1) await figma.loadAllPagesAsync();

  var scopes = [];
  var ids = ["selection", "page", "file"];
  for (var i = 0; i < ids.length; i++) {
    var groups;
    try {
      groups = await resolveScope(ids[i]);
    } catch (err) {
      scopes.push({ id: ids[i], unit: "layer", count: 0, pages: 0, empty: true });
      continue;
    }
    var nodes = [];
    for (var g = 0; g < groups.length; g++) nodes = nodes.concat(groups[g].nodes);
    var deck = isSlidesDeck() && ids[i] !== "selection";
    scopes.push({
      id: ids[i],
      unit: deck ? "slide" : "layer",
      count: countUnder(nodes),
      pages: groups.length,
      empty: nodes.length === 0
    });
  }
  return { type: "scopes", scopes: scopes };
}

/** Every node in the subtree, the roots included. */
function countUnder(nodes) {
  var total = 0;
  for (var i = 0; i < nodes.length; i++) {
    var found = nodes[i].findAll ? nodes[i].findAll(function () { return true; }) : [];
    total += found.length + 1;
  }
  return total;
}

/**
 * The export itself, up to the point the two packagings diverge.
 *
 * Everything a Figma export costs is paid HERE and paid ONCE: the scope is
 * resolved, every instance's master is looked up, the tree is walked, and the
 * image bytes are read. What happens next — a zip on disk or text on the
 * clipboard — is a packaging decision, and making it after this point is what
 * keeps the two doors from ever walking the document differently.
 *
 * Image bytes are read AFTER the walk and streamed one image per message, because
 * base64 inflates by a third and a single `postMessage` carrying a few dozen
 * megabytes is how the UI iframe stops responding. The map is keyed by imageHash,
 * which is the same key the app calls `imageRef`. Video posters ride the same map,
 * under the clip's hash, because a poster is what the app paints for a video and
 * it has to be resolved by the ref the paint carries.
 */
/**
 * The file's own variables, and the collections that own their modes.
 *
 * Both are ASYNC in the plugin API (`getLocalVariablesAsync` /
 * `getLocalVariableCollectionsAsync`) while `collect.js` is deliberately a pure
 * synchronous transport that runs under `vm` with no Figma at all — so they are
 * resolved here and handed in, the same way `getMainComponentAsync` resolves the
 * instance ids before the walk. That split is what keeps the transport testable.
 *
 * Carried VERBATIM. A variable's value is filed by MODE ID and only the
 * collection says which id is the default and what the others are called, so the
 * two have to travel together or the app cannot tell a light value from a dark
 * one.
 */
async function resolveVariables() {
  if (!figma.variables || typeof figma.variables.getLocalVariablesAsync !== "function") return null;
  try {
    var variables = await figma.variables.getLocalVariablesAsync();
    var collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!variables || variables.length === 0) return null;
    return { variables: variables, collections: collections || [] };
  } catch (err) {
    // A file with no variables, or an API that will not answer: an export that
    // carries none is the same export it has always been, not a failed one.
    return null;
  }
}

/**
 * The file's published styles, with the values they are built from.
 *
 * Four readers rather than one because the plugin API splits them by kind, and
 * each is optional: a build that predates styles on a kind returns nothing and
 * the style simply does not arrive. Same split as `resolveVariables` — the
 * transport under `vm` cannot call Figma, so everything async is resolved here
 * and handed in.
 *
 * A style whose kind the app cannot express (a GRID style) still travels: which
 * one of them FISH can hold is the app's call, and a style dropped here would be
 * a file that looks like it never had one.
 */
async function resolveStyles() {
  var readers = [
    "getLocalPaintStylesAsync",
    "getLocalTextStylesAsync",
    "getLocalEffectStylesAsync",
    "getLocalGridStylesAsync"
  ];
  var styles = [];
  for (var i = 0; i < readers.length; i++) {
    if (typeof figma[readers[i]] !== "function") continue;
    try {
      var list = await figma[readers[i]]();
      if (Array.isArray(list)) styles = styles.concat(list);
    } catch (err) {
      // A kind that will not answer is a kind that does not arrive — the export
      // is still the export it has always been, not a failed one.
    }
  }
  return styles.length > 0 ? styles : null;
}

async function prepareExport(scope, withImages) {
  var groups = await resolveScope(scope);
  var nodes = [];
  for (var g = 0; g < groups.length; g++) nodes = nodes.concat(groups[g].nodes);
  var componentIds = await resolveComponentIds(nodes);
  var design = await resolveVariables();
  var styleDefs = await resolveStyles();
  var envelope = buildExport(groups, {
    scope: scope,
    documentId: figma.root.id,
    documentName: figma.root.name,
    exportedAt: new Date().toISOString(),
    ctx: { componentIds: componentIds },
    images: {},
    variables: design ? design.variables : undefined,
    variableCollections: design ? design.collections : undefined,
    styles: styleDefs || undefined,
    unreadable: unreadableOf(nodes)
  });

  var imageBytes = {};
  var imageCount = 0;
  if (withImages) {
    var refs = collectImageHashes(envelope.document);
    var posters = videoPosterRefs(nodes);
    var total = refs.length + posters.length;
    var done = 0;
    for (var i = 0; i < refs.length; i++) {
      var bytes = await readImage(refs[i]);
      done += 1;
      figma.ui.postMessage({ type: "progress", done: done, total: total });
      if (!bytes) continue;
      imageBytes[refs[i]] = bytes;
      envelope.images[refs[i]] = "pending";
      imageCount += 1;
    }
    // After the images, and on the same stream: a poster is a picture like any
    // other, so it is read the same way, counted the same way, and gated by the
    // same "Include images" tick — one policy for "do bitmaps travel".
    for (var p = 0; p < posters.length; p++) {
      var poster = await readVideoPoster(posters[p].node);
      done += 1;
      figma.ui.postMessage({ type: "progress", done: done, total: total });
      if (!poster) continue;
      imageBytes[posters[p].ref] = poster;
      envelope.images[posters[p].ref] = "pending";
      imageCount += 1;
    }
  }
  return { envelope: envelope, imageBytes: imageBytes, imageCount: imageCount };
}

/** The file packaging: a STORED zip, posted to the UI in pieces. */
async function runExport(scope, withImages) {
  var prepared = await prepareExport(scope, withImages);
  var archive = buildBundle(prepared.envelope, prepared.imageBytes);
  postArchive(function (message) { figma.ui.postMessage(message); }, archive, prepared.imageCount);
}

/**
 * The clipboard packaging: the envelope as TEXT, images inlined as data URIs.
 *
 * A zip is bytes and the clipboard is text, so the images travel the other way
 * here — and the app's reader accepts either, because an image value is a
 * locator to it whichever form it takes. Over `COPY_TEXT_LIMIT` the copy is
 * REFUSED with a sentence instead of attempted: the plugin says how big it is
 * and what to do instead, which is the difference between a designer unticking
 * "Include images" and a designer reporting that the copy button does nothing.
 *
 * The text goes over the SAME chunked transport as the file — one protocol, two
 * endings — so a copy the size of a small deck moves without the iframe ever
 * holding all of it in one message.
 */
async function runCopy(scope, withImages) {
  var prepared = await prepareExport(scope, withImages);
  var text = buildCopyText(prepared.envelope, prepared.imageBytes);
  if (text.length > COPY_TEXT_LIMIT) {
    return { type: "copy-too-big", size: text.length, limit: COPY_TEXT_LIMIT };
  }
  lastCopy = text;
  postArchive(function (message) { figma.ui.postMessage(message); }, utf8(text), prepared.imageCount, 0, POST_CHUNK, "copied");
  return undefined;
}


/**
 * A page's backdrop colour, as REST spells it on a `CANVAS`.
 *
 * A paint rather than a colour: the plugin reports `backgrounds` as a stack and
 * REST reports one `backgroundColor`, so only a single solid paint has a
 * counterpart and anything else is left absent — the app then paints its own
 * default rather than importing a page backdrop that was never there.
 */
function pageBackground(page) {
  var paints = (page && page.backgrounds) || [];
  for (var i = 0; i < paints.length; i++) {
    var paint = paints[i];
    if (paint && paint.type === "SOLID" && paint.visible !== false && paint.color) {
      var a = paint.opacity === undefined ? 1 : paint.opacity;
      var alpha = (paint.color.a === undefined ? 1 : paint.color.a) * a;
      return { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: alpha };
    }
  }
  return undefined;
}

/**
 * Every instance's real master, resolved through the async getter.
 *
 * `mainComponent` would be the obvious spelling and it is write-only under
 * `dynamic-page`: reading it returns `undefined`, the app then finds no
 * `componentId`, and every instance promotes to a master synthesised from its own
 * content — which is exactly the fallback this plugin exists to remove.
 */
async function resolveComponentIds(nodes) {
  var ids = {};
  var every = [];
  for (var i = 0; i < nodes.length; i++) {
    var found = nodes[i].type === "INSTANCE" ? [nodes[i]] : nodes[i].findAll ? nodes[i].findAll(function (n) { return n.type === "INSTANCE"; }) : [];
    for (var j = 0; j < found.length; j++) every.push(found[j]);
  }

  // Reported, because this is where the time goes: one async round trip per
  // instance, and a real file has about a thousand of them. A button that sits
  // disabled for ten seconds with a progress bar at zero is indistinguishable
  // from a plugin that has hung, and the first report of this was exactly that.
  for (var k = 0; k < every.length; k++) {
    if (k % 50 === 0 || k === every.length - 1) {
      figma.ui.postMessage({ type: "progress", done: k, total: every.length, stage: "components" });
    }
    var main = await every[k].getMainComponentAsync();
    if (main) ids[every[k].id] = main.id;
  }
  return ids;
}

/** Every distinct image the collected tree references, in first-seen order. */
function collectImageHashes(root) {
  var refs = {};
  var order = [];
  (function walk(node) {
    if (!node) return;
    var paints = [].concat(node.fills || [], node.strokes || []);
    for (var i = 0; i < paints.length; i++) {
      var ref = paints[i] && paints[i].imageRef;
      if (ref && !refs[ref]) {
        refs[ref] = true;
        order.push(ref);
      }
    }
    var children = node.children || [];
    for (var c = 0; c < children.length; c++) walk(children[c]);
  })(root);
  return order;
}

/**
 * `getBytesAsync` is the ORIGINAL uploaded bytes — no CDN, no 14-day expiry.
 *
 * They are what they are, and they are big: 38 photographs in one real export
 * totalled 99.6MB once base64 was done to them. Nothing here shrinks them — that
 * is the app's call, made in one place, and a plugin that resized on its own would
 * be making it (`docs/FIGMA_IMPORT_PLAN.md` §0). What this side does is keep them
 * as BYTES, so they never become a string at all.
 */
async function readImage(hash) {
  var image = figma.getImageByHash(hash);
  if (!image) return null;
  return await image.getBytesAsync();
}

/**
 * How many nodes sit on a property this API cannot read.
 *
 * A count, not a judgement: the app decides what an unreadable property is worth
 * saying out loud. Reported rather than thrown away because the alternative is a
 * design that imports a little wrong with nothing in the report to explain it.
 */
function countUnreadable(nodes) {
  var counts = {};
  for (var i = 0; i < nodes.length; i++) {
    var found = nodes[i].type === "FRAME" || nodes[i].type === "COMPONENT" ? [nodes[i]] : [];
    var nested = nodes[i].findAll ? nodes[i].findAll(function (n) { return true; }) : [];
    var all = found.concat(nested);
    for (var j = 0; j < all.length; j++) {
      var lost = UNREADABLE_BY_TYPE[all[j].type];
      if (!lost) continue;
      for (var k = 0; k < lost.length; k++) {
        counts[lost[k]] = (counts[lost[k]] || 0) + 1;
      }
    }
  }
  return counts;
}

/**
 * Video fills in the subtree, which cannot travel at all.
 *
 * A separate walk from `countUnreadable` because the loss is a PAINT rather than
 * a property of a node type, and because the root is the case that matters:
 * dragging a video into Figma makes a lone rectangle with a video fill, and a
 * rectangle carries no `findAll` — the same shape of gap that made this file
 * exist.
 *
 * The count is the whole of what this side can do. A clip's bytes are readable
 * only by handing them to Figma (`figma.createVideoAsync`); there is no
 * `getVideoByHash`, so nothing here can put a video in the export.
 */
function countVideoFills(nodes) {
  var total = 0;
  for (var i = 0; i < nodes.length; i++) {
    var root = nodes[i];
    var nested = root.findAll ? root.findAll(function () { return true; }) : [];
    var all = [root].concat(nested);
    for (var j = 0; j < all.length; j++) {
      var fills = all[j].fills;
      if (!Array.isArray(fills) || isMixed(fills)) continue;
      for (var k = 0; k < fills.length; k++) {
        if (fills[k] && fills[k].type === "VIDEO" && fills[k].visible !== false) total += 1;
      }
    }
  }
  return total;
}

/** What the export declares it could not read, by property. */
function unreadableOf(nodes) {
  var counts = countUnreadable(nodes);
  var video = countVideoFills(nodes);
  if (video > 0) counts.videoBytes = video;
  return counts;
}

/**
 * Every clip in the scope, with the node that carries it.
 *
 * Keyed by the clip's hash and first-wins, so two layers sharing one clip share
 * one poster. The alternative — a poster per layer — buys a sharper picture in
 * the rare case where the same clip is used at two very different sizes, and pays
 * for it with a picture per layer in every case; the poster travels through the
 * SAME image table either way, so this is a size decision and not a shape one.
 *
 * The root is walked as well as the descendants, because the case that matters is
 * a lone video-filled rectangle, and a RectangleNode carries no `findAll`.
 */
function videoPosterRefs(nodes) {
  var seen = {};
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var nested = nodes[i].findAll ? nodes[i].findAll(function () { return true; }) : [];
    var all = [nodes[i]].concat(nested);
    for (var j = 0; j < all.length; j++) {
      var fills = all[j].fills;
      if (!Array.isArray(fills) || isMixed(fills)) continue;
      for (var k = 0; k < fills.length; k++) {
        var fill = fills[k];
        if (!fill || fill.type !== "VIDEO" || fill.visible === false) continue;
        if (!fill.videoHash || seen[fill.videoHash]) continue;
        seen[fill.videoHash] = true;
        out.push({ ref: fill.videoHash, node: all[j] });
      }
    }
  }
  return out;
}

/**
 * The still the layer is showing, as PNG bytes.
 *
 * `exportAsync` renders the NODE rather than the clip, which is exactly what a
 * poster has to be: the frame as that layer draws it — its size, its crop into
 * the clip, its filters — and therefore a picture the app can paint in the
 * layer's place. There is no other door; `figma.getVideoByHash` does not exist
 * (`countVideoFills`).
 *
 * A node the API will not render — a type outside `exportAsync`'s list, a fill
 * inside something it refuses — returns null and is named on the other side
 * rather than thrown, because one clip without a poster must not cost the others.
 */
async function readVideoPoster(node) {
  try {
    return await node.exportAsync({ format: "PNG" });
  } catch (err) {
    return null;
  }
}

/**
 * What the UI needs before anyone touches it: the three scopes, and whether this
 * is a deck — because a deck exports as a row of frames and, unlike a design,
 * has something to say about how it presents. The transitions do come across
 * (`collect.js` reads them, `figma-slide.ts` gives them their meaning), so what
 * the notice has left to warn about is the speaker notes and the approximations.
 */
describeScopes().then(function (message) {
  message.deck = isSlidesDeck();
  figma.ui.postMessage(message);
});
