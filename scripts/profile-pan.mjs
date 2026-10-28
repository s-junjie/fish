#!/usr/bin/env node
/**
 * Where a pan, a zoom or a drag actually spends its frame.
 *
 * The perf work in this repo has been measured with microbenchmarks, which is
 * how the algorithmic wins were found — but they cannot say what a real frame
 * costs once Preact, the browser and the compositor are in the loop, and a
 * microbenchmark cannot drop a frame. This drives the built file in Chromium,
 * records every animation frame the gesture produced, and attributes the CPU
 * samples to functions.
 *
 * Usage: node scripts/profile-pan.mjs [file.fish.html] [options]
 *
 *   --scenario pan|zoom|drag|all   which gesture to drive (default: all)
 *   --frames                       frame pacing: dropped frames, not CPU samples
 *   --trace                        trace paint/raster/decode, per phase and per tile
 *   --dpr 2 --size 1728x1080       model a Retina laptop rather than the default
 *   --open assets|layers           open a side panel first, as a user would
 *   --zoom-to 1                    wheel in before measuring, where editing happens
 *   --strip images|backdrops|both  remove an ingredient to attribute the paint cost
 *   --inject '<css>'               try a candidate style before changing any code
 *   --bitmaps 512                  replace bitmaps with copies at most N px
 *
 * `--frames` answers "does it stutter"; `--trace` answers "on what". A micro-
 * benchmark cannot drop a frame, and a CPU profile cannot see raster or decode —
 * on a document with 39.6 MB of inline bitmaps, that is where the frame goes.
 */

import path from "path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { loadPlaywright } from "./lib/playwright-loader.mjs";

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith("--")) ?? "demo/performance.fish.html";
const scenarioArg = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : "all";
const tracing = args.includes("--trace");
/** Optional `start:end` (ms) filter for the trace, so one bad frame can be read. */
const traceWindow = args.includes("--trace-window")
  ? args[args.indexOf("--trace-window") + 1].split(":").map(Number)
  : null;
/** `--strip backdrops|images|both`: isolate what the paint cost is spent on. */
const strip = args.includes("--strip") ? args[args.indexOf("--strip") + 1] : "none";
/** `--dpr 2` / `--size 1728x1080`: match the machine being modelled. */
const dpr = args.includes("--dpr") ? Number(args[args.indexOf("--dpr") + 1]) : 1;
const size = args.includes("--size")
  ? args[args.indexOf("--size") + 1].split("x").map(Number)
  : [1440, 900];
/** `--frames`: report frame pacing (dropped frames) instead of CPU/trace work. */
const frames = args.includes("--frames");
/** `--window 80:200`: restrict the profile to that slice of the gesture, in ms. */
const windowArg = args.includes("--window") ? args[args.indexOf("--window") + 1].split(":").map(Number) : null;
/** `--inclusive <fn>`: total time spent inside a function and everything it calls. */
const inclusive = args.includes("--inclusive") ? args[args.indexOf("--inclusive") + 1] : "";
/** `--callers <fn>`: print the call path into a hot function. */
const callers = args.includes("--callers") ? args[args.indexOf("--callers") + 1] : "";
/** `--target largest`: drag the biggest on-screen element, not the first. */
const dragTarget = args.includes("--target") ? args[args.indexOf("--target") + 1] : "first";
/** `--open assets|layers`: put the side panel on screen first, as a user would. */
const openPanel = args.includes("--open") ? args[args.indexOf("--open") + 1] : "";
/** `--zoom-to 1`: wheel in to this zoom before measuring, where editing happens. */
const zoomTo = args.includes("--zoom-to") ? Number(args[args.indexOf("--zoom-to") + 1]) : 0;
/** `--bitmaps N`: replace bitmaps with copies at most N px, then measure again. */
const bitmapLimit = args.includes("--bitmaps") ? Number(args[args.indexOf("--bitmaps") + 1]) : 0;
/** `--inject <css>`: try a candidate style on the live canvas before changing code. */
const inject = args.includes("--inject") ? args[args.indexOf("--inject") + 1] : "";
const target = path.resolve(process.cwd(), fileArg);
if (!fs.existsSync(target)) {
  console.error(`no such file: ${target}`);
  process.exit(2);
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  // A Retina laptop is the machine that stutters: the same tiles are rastered at
  // 4x the pixels, and raster (not JS) is where a zoom frame goes.
  const context = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: dpr
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const t0 = Date.now();
  await page.goto(pathToFileURL(target).href);
  await page.waitForFunction(() => Boolean(document.querySelector("[data-canvas-root]")), null, {
    timeout: 120000
  });
  // The file's cover is generated on a 400 ms debounce after boot; its encode is
  // a ~100 ms main-thread task that would otherwise be charged to the first
  // gesture. Wait it out before measuring anything.
  await page.waitForTimeout(2500);
  console.log(`booted in ${Date.now() - t0} ms (settled) · ${size[0]}x${size[1]} @${dpr}x`);

  /**
   * Long tasks, not rAF gaps: headless Chromium does not throttle rAF to a
   * display, so a frame gap there says nothing about a dropped frame. A task
   * that blocks the main thread for over 50 ms is what the user feels, and it
   * is the number this report is about.
   */
  await page.evaluate(() => {
    const state = { tasks: [] };
    window.__longTasks = state;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.tasks.push({ d: entry.duration, at: entry.startTime - (window.__t0 || 0) });
    }).observe({ entryTypes: ["longtask"] });
  });
  /**
   * Take one ingredient out of the picture and measure again.
   *
   * Raster is where a frame goes on a document like this one, and a CPU profile
   * cannot say which ingredient it is. Removing the glass, or the bitmaps, and
   * re-running the same gesture is the only honest attribution.
   */
/**
 * Replace every large bitmap with a display-resolution copy.
 *
 * The question this answers: how much of a zoom frame is spent re-scaling a
 * 4800-pixel-wide source into a 300-pixel box, at every rung of the zoom. The
 * copies are made on a canvas in the page, so it is the same pipeline the app
 * would use — only the source resolution changes.
 */
async function downscaleBitmaps(limit) {
  const replaced = await page.evaluate(async (max) => {
    const svg = document.querySelector("[data-canvas-root] svg");
    const targets = [...svg.querySelectorAll("image")];
    let count = 0;
    for (const img of targets) {
      const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
      if (!href.startsWith("data:image") || href.length < 2048) continue;
      const bitmap = new Image();
      bitmap.src = href;
      try {
        await bitmap.decode();
      } catch {
        continue;
      }
      const scale = Math.min(1, max / Math.max(bitmap.naturalWidth, bitmap.naturalHeight));
      if (scale >= 0.999) continue;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(bitmap.naturalHeight * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const next = canvas.toDataURL(href.startsWith("data:image/png") ? "image/png" : "image/jpeg", 0.9);
      img.setAttribute("href", next);
      count++;
    }
    return count;
  }, limit);
  console.log(`downscaled ${replaced} bitmaps to <= ${limit}px`);
  await page.waitForTimeout(800);
}

  const applyStrip = async () => {
    if (inject) {
      await page.addStyleTag({ content: inject });
      await page.waitForTimeout(300);
    }
    if (strip === "none") return;
    await page.evaluate((what) => {
      if (what === "backdrops" || what === "both") {
        for (const el of document.querySelectorAll("*")) {
          const style = el.style;
          if (style && style.backdropFilter) {
            style.backdropFilter = "none";
            style.setProperty("-webkit-backdrop-filter", "none");
          }
        }
        document.documentElement.dataset.strippedBackdrops = "1";
      }
      if (what === "images" || what === "both") {
        for (const img of document.querySelectorAll("image")) {
          const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
          if (href.length < 1000) continue;
          img.setAttribute("href", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E");
        }
        document.documentElement.dataset.strippedImages = "1";
      }
    }, strip);
    await page.waitForTimeout(500);
  };

  const startRecording = () => page.evaluate(() => {
    window.__longTasks.tasks = [];
    window.__t0 = performance.now();
  });
  const stopRecording = () =>
    page.evaluate(() => ({ tasks: window.__longTasks.tasks.slice(), wall: performance.now() - window.__t0 }));

  /**
   * Raster and image decode do not run in JS, so a CPU profile cannot see them —
   * and on a document carrying 39.6 MB of bitmaps they are where the frame goes.
   * The trace reports them per phase, on the renderer main thread only.
   */
  const beginTrace = async () => {
    const { categories } = await cdp.send("Tracing.getCategories");
    void categories;
    await cdp.send("Tracing.start", {
      transferMode: "ReturnAsStream",
      categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.image_decoding,cc,skia"
    });
  };
  const endTrace = async () => {
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    const { stream } = await done;
    let text = "";
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream });
      text += chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    return traceSummary(JSON.parse(text));
  };

  const beginProfile = async () => {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  };
  const endProfile = async () => {
    const { profile } = await cdp.send("Profiler.stop");
    lastProfile = windowArg ? sliceProfile(profile, windowArg[0], windowArg[1]) : profile;
    return selfTimeByFunction(lastProfile);
  };

  const at = { x: 720, y: 450 };

  /**
   * Frame pacing, measured as the renderer sees it.
   *
   * Chromium in headless drives rAF from BeginFrame, so a rAF callback that
   * arrives 33 ms after the previous one means exactly one dropped frame — the
   * number the user feels. No CPU profile runs in this mode (sampling adds its
   * own gaps), which is why it is a separate switch rather than always on.
   */
  const beginFrames = () =>
    page.evaluate(() => {
      const log = { gaps: [], last: 0, on: false };
      window.__frames = log;
      const tick = (t) => {
        if (log.on) {
          if (log.last) log.gaps.push(t - log.last);
          log.last = t;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const startFrames = () =>
    page.evaluate(() => {
      window.__frames.gaps = [];
      window.__frames.last = 0;
      window.__frames.on = true;
    });
  const stopFrames = () =>
    page.evaluate(() => {
      window.__frames.on = false;
      return window.__frames.gaps.slice();
    });

  async function runScenario(name, gesture) {
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(200);
    if (!frames) await beginProfile();
    if (tracing) await beginTrace();
    if (frames) {
      await startFrames();
      await gesture();
      const gaps = await stopFrames();
      reportFrames(name, gaps);
      if (tracing) await endTrace();
      return;
    }
    await startRecording();
    await gesture();
    const { tasks, wall } = await stopRecording();
    const byFn = await endProfile();
    const byPhase = tracing ? await endTrace() : null;
    const durations = tasks.map((t) => (typeof t === "number" ? t : t.d));
    const worst = durations.length ? Math.max(...durations) : 0;
    const blocked = durations.reduce((n, d) => n + d, 0);
    console.log(
      `\n${name}: ${wall.toFixed(0)} ms wall · ${tasks.length} long tasks · blocked ${blocked.toFixed(0)} ms · worst ${worst.toFixed(
        0
      )} ms`
    );
    for (const t of tasks) {
      if (typeof t === "number") continue;
      console.log(`     long task ${t.d.toFixed(0)} ms starting ${t.at.toFixed(0)} ms into the gesture`);
    }
    if (byPhase) {
      for (const [phase, ms] of byPhase.slice(0, 10)) console.log(`   ${ms.toFixed(1).padStart(7)} ms  [${phase}]`);
      console.log("");
      for (const phase of ["DisplayItemList::Raster", "Decode Image", "Paint", "BeginMainFrame"]) {
        const dist = percentiles(lastPerEvent.get(phase));
        if (!dist) continue;
        console.log(
          `   ${phase}: ${dist.n}x · p50 ${dist.p50.toFixed(2)} · p95 ${dist.p95.toFixed(2)} · max ${dist.max.toFixed(
            2
          )} ms`
        );
      }
      console.log("");
    }
    for (const [fn, ms] of byFn.slice(0, 12)) console.log(`   ${ms.toFixed(1).padStart(7)} ms  ${fn}`);
    if (callers && lastProfile) {
      const { count, paths } = callPaths(lastProfile, callers);
      console.log(`\n   callers of ${callers} (${count} samples):`);
      for (const [chain, n] of paths) console.log(`     ${String(n).padStart(4)}x  ${chain}`);
    }
    if (inclusive && lastProfile) {
      const totals = inclusiveTime(lastProfile, inclusive);
      console.log(`\n   inclusive time under "${inclusive}":`);
      for (const [fn, ms] of totals.slice(0, 12)) console.log(`     ${ms.toFixed(1).padStart(7)} ms  ${fn}`);
    }
  }

  if (openPanel) {
    const clicked = await page.evaluate((which) => {
      const labels = which === "assets" ? /asset|资源|素材/i : /layer|图层/i;
      const tabs = [...document.querySelectorAll("[role=tab],button")];
      const hit = tabs.find((el) => labels.test(el.getAttribute("aria-label") || el.textContent || ""));
      if (hit) hit.click();
      return Boolean(hit);
    }, openPanel);
    await page.waitForTimeout(1500);
    console.log(`opened ${openPanel} panel: ${clicked}`);
  }
  if (zoomTo) {
    await page.evaluate(async (target) => {
      const svg = document.querySelector("[data-canvas-root] svg");
      for (let i = 0; i < 200; i++) {
        const current = Number(getComputedStyle(svg).getPropertyValue("--fish-zoom")) || 0.16;
        if (current >= target) break;
        svg.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -30, ctrlKey: true, bubbles: true, cancelable: true, clientX: 800, clientY: 540 })
        );
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, zoomTo);
    await page.waitForTimeout(1200);
    console.log(`pre-zoomed to ${await page.evaluate(() => getComputedStyle(document.querySelector("[data-canvas-root] svg")).getPropertyValue("--fish-zoom"))}`);
  }
  await applyStrip();
  if (bitmapLimit) await downscaleBitmaps(bitmapLimit);
  if (frames) await beginFrames();

  if (scenarioArg === "pan" || scenarioArg === "all") {
    await runScenario("pan (60 wheel steps)", async () => {
      for (let i = 0; i < 60; i++) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: i % 2 ? 6 : -6,
          deltaY: i % 2 ? 5 : -5
        });
      }
    });
  }

  if (scenarioArg === "zoom" || scenarioArg === "all") {
    await runScenario("zoom (ctrl+wheel, 40 steps)", async () => {
      for (let i = 0; i < 40; i++) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: 0,
          deltaY: i < 20 ? 24 : -24,
          modifiers: 2
        });
      }
    });
  }

  if (scenarioArg === "click") {
    const box = await page.evaluate(() => {
      const candidates = [];
      for (const hit of document.querySelectorAll("[data-hit]")) {
        const r = hit.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) continue;
        if (r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
        candidates.push({ area: r.width * r.height, x: r.x + r.width / 2, y: r.y + r.height / 2 });
      }
      return candidates.sort((a, b) => b.area - a.area)[0] ?? null;
    });
    if (!box) {
      console.log("\nclick: no target");
    } else {
      await runScenario("click (select one element)", async () => {
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(300);
      });
    }
  }

  if (scenarioArg === "drag" || scenarioArg === "all") {
    // The FIRST `[data-hit]` in document order is usually a zero-sized or
    // off-screen node, which is why this scenario used to report "no target".
    // Take the first one that is actually on screen and big enough to grab.
    // Which element gets dragged decides the measurement: moving a full frame
    // touches every child, moving a rect touches one. `--target largest` takes
    // the biggest thing on screen, which is the case a user notices.
    const box = await page.evaluate((pick) => {
      const candidates = [];
      for (const hit of document.querySelectorAll("[data-hit]")) {
        const r = hit.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) continue;
        if (r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
        candidates.push({ area: r.width * r.height, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height });
      }
      if (candidates.length === 0) return null;
      const picked = pick === "largest" ? candidates.sort((a, b) => b.area - a.area)[0] : candidates[0];
      return { x: picked.x, y: picked.y, w: picked.w, h: picked.h };
    }, dragTarget);
    if (!box) {
      console.log("\ndrag: no [data-hit] target found");
    } else {
      if (args.includes("--preselect")) {
        // Select first, then drag the same element: separates the cost of
        // "something got selected" from "something started moving".
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(600);
      }
      console.log(`drag target: ${box.w.toFixed(0)}x${box.h.toFixed(0)} at ${box.x.toFixed(0)},${box.y.toFixed(0)}`);
      await runScenario("drag (40 moves)", async () => {
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        // One move per ~8 ms, which is what a real pointer delivers. Firing them
        // all at once is worse than useless: the rAF coalescer keeps only the
        // last position, so 40 moves collapse into a handful of frames and the
        // gesture measures as if it were instant.
        for (let i = 1; i <= 40; i++) {
          await page.mouse.move(box.x + i * 4, box.y + i * 3);
          await page.waitForTimeout(8);
        }
        await page.mouse.up();
      });
    }
  }

  await browser.close();
}

/**
 * Self time per function, from the V8 CPU profile.
 *
 * `timeDeltas[i]` is the time charged to `samples[i]`, so summing by sample and
 * mapping through `callFrame` gives the function that was ON the stack — the
 * only attribution that says what to fix.
 */
function selfTimeByFunction(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const totals = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const frame = node.callFrame;
    const name = `${frame.functionName || "(anonymous)"}  ${path.basename(frame.url || "")}:${frame.lineNumber + 1}`;
    totals.set(name, (totals.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * The profile, cut to a slice of the gesture.
 *
 * A 70 ms task somewhere in a 1.3 s gesture disappears into the totals, and
 * "which function" is not the question — "which function in THAT window" is.
 * `timeDeltas` is a running clock, so the slice is an offset filter.
 */
function sliceProfile(profile, fromMs, toMs) {
  const samples = [];
  const timeDeltas = [];
  let at = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    at += (profile.timeDeltas[i] ?? 0) / 1000;
    if (at < fromMs || at > toMs) continue;
    samples.push(profile.samples[i]);
    timeDeltas.push(profile.timeDeltas[i] ?? 0);
  }
  return { ...profile, samples, timeDeltas };
}

/**
 * Inclusive time: everything that ran while `needle` was on the stack.
 *
 * Self time answers "which line is expensive" and is useless for a component:
 * `<CanvasDefs>` may own 2 ms itself and 30 ms of the work it delegates. The
 * stack is already in the profile, so tagging each sample by its ancestors gives
 * the cost of the subtree.
 */
function inclusiveTime(profile, needle) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);
  const totals = new Map();
  let hit = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const start = byId.get(profile.samples[i]);
    if (!start) continue;
    // Walk up until the needle is found; if it is, charge the sample to it.
    let cursor = start;
    let found = false;
    for (let depth = 0; depth < 64 && cursor; depth++) {
      if ((cursor.callFrame.functionName || "").includes(needle)) {
        found = true;
        break;
      }
      cursor = byId.get(parentOf.get(cursor.id));
    }
    if (!found) continue;
    hit++;
    const f = start.callFrame;
    const name = `${f.functionName || "(anonymous)"}  ${path.basename(f.url || "")}:${f.lineNumber + 1}`;
    totals.set(name, (totals.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  if (hit === 0) return [];
  totals.set("── total ──", [...totals.values()].reduce((a, b) => a + b, 0));
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Who calls `needle`, and how often.
 *
 * Self time names the expensive function but not the code that decided to run
 * it, and for a hot function reached from three places that is the difference
 * between fixing the right caller and the wrong one. The profile is a tree of
 * nodes with `parent` pointers, so the path from the root is already there.
 */
function callPaths(profile, needle) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);
  const hits = new Map();
  let count = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    if (!(node.callFrame.functionName || "").includes(needle)) continue;
    count++;
    const chain = [];
    let cursor = node;
    for (let depth = 0; depth < 8 && cursor; depth++) {
      const f = cursor.callFrame;
      chain.unshift(`${f.functionName || "(anonymous)"}:${f.lineNumber + 1}`);
      cursor = byId.get(parentOf.get(cursor.id));
    }
    const key = chain.join(" < ");
    hits.set(key, (hits.get(key) ?? 0) + 1);
  }
  return { count, paths: [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) };
}

/**
 * Frame gaps as a user perceives them: a gap of two refresh intervals is one
 * dropped frame. The budget is taken from the fixture itself (its own p50) rather
 * than assumed to be 16.7 ms, because a headless BeginFrame source is not
 * guaranteed to be a 60 Hz display.
 */
function reportFrames(name, gaps) {
  if (gaps.length === 0) {
    console.log(`\n${name}: no frames recorded`);
    return;
  }
  const dist = percentiles(gaps);
  const budget = dist.p50 * 1.5;
  const dropped = gaps.filter((g) => g > budget).length;
  const worstDrops = Math.round((dist.max / dist.p50 - 1));
  console.log(
    `\n${name}: ${gaps.length} frames · p50 ${dist.p50.toFixed(1)} · p95 ${dist.p95.toFixed(1)} · max ${dist.max.toFixed(
      1
    )} ms · dropped ${dropped} (${((dropped / gaps.length) * 100).toFixed(0)}%) · worst ${worstDrops} frames`
  );
}

/**
 * Time per trace event name, renderer main thread only, in ms.
 *
 * `Rasterize`/`Paint`/`Decode Image` are what the compositor and the image cache
 * cost a frame; `RunTask`/`FunctionCall` would otherwise swamp them, so tasks
 * are excluded and only the leaf work is summed.
 */
/** Durations of the last trace, by event name, for the per-frame percentiles. */
let lastPerEvent = new Map();
/** The last CPU profile, kept so `--callers` can walk up from a hot function. */
let lastProfile = null;

function traceSummary(trace) {
  const totals = new Map();
  const samples = new Map();
  const skip = new Set(["RunTask", "ThreadControllerImpl::RunTask", "ThreadPool_RunTask", "SequenceTask"]);
  const events = trace.traceEvents ?? trace;
  // Trace timestamps are absolute microseconds; the window is relative to the
  // first event, which is where the gesture starts.
  const origin = events.length ? events[0].ts : 0;
  for (const e of events) {
    if (e.ph !== "X" || typeof e.dur !== "number") continue;
    if (!e.name) continue;
    if (skip.has(e.name)) continue;
    if (traceWindow) {
      const at = (e.ts - origin) / 1000;
      if (at < traceWindow[0] || at > traceWindow[1]) continue;
    }
    totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000);
    const list = samples.get(e.name);
    if (list) list.push(e.dur / 1000);
    else samples.set(e.name, [e.dur / 1000]);
  }
  trace.perEvent = samples;
  lastPerEvent = samples;
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * The per-frame question, which the totals cannot answer.
 *
 * Raster fans out over worker threads, so a sum over a 40-step gesture says what
 * the gesture cost and nothing about whether ONE frame fit in 16.7 ms. The
 * distribution of a single task does: a p95 of 3 ms under a 21 ms sum means the
 * threads were busy in parallel and the frame was fine; a p95 of 21 ms means one
 * thread carried it.
 */
function percentiles(list) {
  if (!list || list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

await main();
