/**
 * `fish` — the CLI half of the agent kit.
 *
 * `check` exists because every other answer the engine gives comes back through
 * a browser: a document had to be rendered before anyone could say whether the
 * engine had quietly rewritten it. Normalize and validate are pure, so they run
 * here with no browser at all, which makes "did I break it" a one-line question
 * instead of a screenshot round-trip — and gives CI an exit code.
 *
 * Bundled by `scripts/build-fish-agent-kit.mjs` into a single dependency-free file.
 */

import fs from "node:fs";
import { assetsCommand, compactCommand } from "./fish-assets";
import { importHtmlPage } from "./html-import";
import { kitIdentityCheck, kitRootOf } from "./kit-identity";
import { checkKitUpdate } from "./kit-update";
import type { KitUpdate } from "./kit-update";
import { brief } from "./fish-brief";
import { inspect } from "./fish-inspect";
import { commentsCommand } from "./fish-comments";
import { APP_VERSION } from "../version";
import { auditToleranceOf } from "../export-request";
import { check } from "./fish-check";
import { apply } from "./fish-apply";
import { compose } from "./fish-compose";
import { exportDocument } from "./fish-export";

const USAGE = `fish — the FISH agent CLI (nothing to install)

  ./fish --version [--check]
  ./fish check <doc.fish.html | doc.json> [--json] [--strict] [--geometry] [--audit] [--audit-tolerance N] [--strict-assets]
  ./fish brief <doc.fish.html | doc.json> [--json]
  ./fish inspect <elementId> <doc.fish.html | doc.json> [--all] [--json]
  ./fish compact <doc.fish.html | doc.json> [-o|--out FILE]
  ./fish assets <doc.fish.html | doc.json> [--json]
  ./fish assets search <query> [--source openverse|lucide|ri] [--limit N] [--add-to <doc>] [--pick N] [--embed] [--to <elementId>] [--replace] [--json]
  ./fish assets import <file...> <doc.fish.html> [--name N] [--to <elementId>] [--replace] [--json]
  ./fish assets embed <doc.fish.html> (--id <assetId> | --all) [--json]
  ./fish apply <ops.json | '[{"op":"patch",...}]'> <doc.fish.html> [-o|--out FILE] [--compact] [--json]
  ./fish comments list|pending <doc.fish.html>
  ./fish comments context <doc.fish.html> <threadId>
  ./fish comments suggest <doc.fish.html> <threadId> --summary <text> --ops <ops.json|'[...]'>
  ./fish comments reply <doc.fish.html> <threadId> --text <text>
  ./fish comments resolve <doc.fish.html> <threadId> [--reply <text>]
  ./fish import <page.html> [-o|--out FILE] [--viewport N] [--viewport-height N] [--name N] [--template FILE] [--compact] [--json]
  ./fish compose <design.json | -> <template.fish.html> [-o|--out FILE] [--compact]
  ./fish export <doc.fish.html> [-o|--out FILE] [--scale N] [--element ID]

check    normalize + validate the document block and print what the engine would change.
brief    report the tokens, styles, components, assets and fonts the document already carries.
inspect  report ONE element: the box it actually got, its effective style, its parents,
         and — for an instance — the slots its overrides may address.
compact  emit the canonical compact JSON of a document, assets preserved.
assets   inspect doc.assets[] with the size each one costs; search, import or embed.
apply    run the macro-ops of the authoring guide against the document block, in place.
compose  inject a design.json into the shell without regex pitfalls or string corruption.
import   measure a page in a real browser and emit an editable document.
export   render a PNG of a document through a headless browser (PNG only).

Exit codes: 0 clean, 1 an error diagnostic or a failed op, 2 bad usage.

--check  (with --version) ask the release origin whether a newer FISH is published.
         This is the manual form of a check that otherwise runs at most once a day,
         silently, and only reports a kit that is behind. FISH_NO_UPDATE_CHECK=1
         turns both off.

What a report means, and which check to run when: references/workflow.md.
What each flag's diagnostics are: references/dsl.md.
This text is the syntax, not the judgement.
`;
// ---------------------------------------------------------------------------

function main(argv: string[]): number | Promise<number> {
  // Answered before anything else: the kit's `SKILL.md` tells an agent to compare
  // this against the version it was written for, so it must cost nothing to ask.
  // `--check` is the manual form of the question, and the only path here that
  // touches the network — an agent that suspects it is behind can ask on purpose
  // instead of paying for a probe it did not need.
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    console.log(`fish ${APP_VERSION}`);
    if (!argv.includes("--check")) return 0;
    return checkKitUpdate({ force: true }).then((result) => {
      console.log(freshnessLine(result));
      return 0;
    });
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv.includes("help")) {
    console.log(USAGE);
    return 0;
  }
  // Asked before any command acts, and after `--version` / `help`: the two ways
  // to diagnose a broken install must keep working when it is broken. A skill is
  // installed once and never refreshed by the app it drives, so this is the only
  // place the prose and the engine can be compared — and when they disagree the
  // prose is what an agent has already read.
  const identity = kitIdentityCheck(kitRootOf(process.argv[1]));
  if (identity.status === "mismatch") {
    console.error(identity.message);
    return 2;
  }
  return checkKitUpdate().then((result) => {
    // Once a day, on the run that asked: a warning repeated from the cache would
    // greet every `check` in a loop, which is how a real warning gets ignored.
    if (result.status === "behind" && !result.fromCache) console.error(result.message);
    return dispatch(argv);
  });
}

/** Everything the pre-flight decided not to answer: the command itself. */
function dispatch(argv: string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));

  // Extract flag values so they do not bleed into positional args
  const getOpt = (long: string, short?: string): string | undefined => {
    const lIdx = rest.indexOf(long);
    if (lIdx >= 0 && lIdx + 1 < rest.length) return rest[lIdx + 1];
    if (short) {
      const sIdx = rest.indexOf(short);
      if (sIdx >= 0 && sIdx + 1 < rest.length) return rest[sIdx + 1];
    }
    return undefined;
  };

  const out = getOpt("--out", "-o");
  const format = getOpt("--format");
  const scaleStr = getOpt("--scale");
  const scale = scaleStr !== undefined ? Number(scaleStr) : undefined;
  const element = getOpt("--element");
  const source = getOpt("--source");
  const limitStr = getOpt("--limit");
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;
  const addTo = getOpt("--add-to");
  const to = getOpt("--to");
  const pickStr = getOpt("--pick");
  const pick = pickStr !== undefined ? Number(pickStr) : undefined;
  const id = getOpt("--id");
  const name = getOpt("--name");
  const viewportStr = getOpt("--viewport");
  const viewport = viewportStr !== undefined ? Number(viewportStr) : undefined;
  const viewportHeightStr = getOpt("--viewport-height");
  const viewportHeight = viewportHeightStr !== undefined ? Number(viewportHeightStr) : undefined;
  const template = getOpt("--template");
  const auditTolerance = auditToleranceOf(getOpt("--audit-tolerance"));
  const summary = getOpt("--summary");
  const ops = getOpt("--ops");
  const reply = getOpt("--reply");
  const text = getOpt("--text");

  // Collect positional arguments, skipping known flags and their values
  const skipIndices = new Set<number>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      skipIndices.add(i);
      if (
        [
          "--out",
          "--format",
          "--scale",
          "--element",
          "--source",
          "--limit",
          "--add-to",
          "--to",
          "--pick",
          "--id",
          "--name",
          "--viewport",
          "--viewport-height",
          "--template",
          "--audit-tolerance",
          "--summary",
          "--ops",
          "--reply",
          "--text"
        ].includes(a) &&
        i + 1 < rest.length
      ) {
        skipIndices.add(i + 1);
      }
    } else if (a === "-o" && i + 1 < rest.length) {
      skipIndices.add(i);
      skipIndices.add(i + 1);
    }
  }
  const args = rest.filter((_, idx) => !skipIndices.has(idx));

  const opts = {
    json: flags.has("--json"),
    strict: flags.has("--strict"),
    geometry: flags.has("--geometry"),
    audit: flags.has("--audit"),
    strictAssets: flags.has("--strict-assets"),
    compact: flags.has("--compact"),
    embed: flags.has("--embed"),
    all: flags.has("--all"),
    replace: flags.has("--replace"),
    out,
    format,
    scale,
    element,
    source,
    limit,
    addTo,
    to,
    pick,
    id,
    name,
    viewport,
    viewportHeight,
    template,
    auditTolerance,
    summary,
    ops,
    reply,
    text
  };
  if (command === "check") {
    if (args.length < 1) return usage("check needs a document");
    return check(args[0], opts);
  }
  if (command === "brief") {
    if (args.length < 1) return usage("brief needs a document");
    return brief(args[0], opts);
  }
  if (command === "inspect") {
    if (args.length < 2) return usage("inspect needs an element id and a document");
    // `<id> <doc>` reads like the command; `<doc> <id>` is how every other
    // subcommand is written, so the order is taken from which one is a file.
    const [first, second] = fs.existsSync(args[0]) ? [args[1], args[0]] : [args[0], args[1]];
    return inspect(second, first, { json: opts.json, allSlots: opts.all });
  }
  if (command === "compact") {
    if (args.length < 1) return usage("compact needs a document");
    return compactCommand(args[0], opts);
  }
  if (command === "assets") {
    return assetsCommand(args, opts);
  }
  if (command === "comments") {
    return commentsCommand(args, opts);
  }
  if (command === "apply") {
    if (args.length < 2) return usage("apply needs ops and a document");
    return apply(args[0], args[1], opts);
  }
  if (command === "import") {
    if (args.length < 1) return usage("import needs a .html page");
    return importHtmlPage(args[0], {
      out: opts.out,
      viewport: opts.viewport,
      viewportHeight: opts.viewportHeight,
      name: opts.name,
      compact: opts.compact,
      json: opts.json,
      template: opts.template
    });
  }
  if (command === "compose") {
    const jsonFile = args[0];
    const templateFile = args[1] ?? (opts.out ? "templates/blank.fish.html" : undefined);
    if (!jsonFile || !templateFile) return usage("compose needs a design.json and a template.fish.html (or --out with default template)");
    return compose(jsonFile, templateFile, opts);
  }
  if (command === "export") {
    if (args.length < 1) return usage("export needs a document (.fish.html)");
    return exportDocument(args[0], opts);
  }
  return usage(`unknown command "${command}"`);
}

/**
 * The answer to `--version --check`, in one line per state. "I could not ask" and
 * "you are current" are worded differently on purpose: a check that cannot
 * distinguish them would report the first as the second, which is the one claim
 * it has no basis for.
 */
function freshnessLine(result: KitUpdate): string {
  switch (result.status) {
    case "behind":
      return result.message;
    case "current":
      return `  release ${result.latest} — this kit is current.`;
    case "unknown":
      return "  the release could not be read (offline, or the origin did not answer) — this kit may be behind.";
    case "off":
      if (result.reason === "opted-out") return "  release check is off (FISH_NO_UPDATE_CHECK).";
      if (result.reason === "dev-build") return "  a dev build has no release to compare against.";
      return "  this build carries no release origin, so there is nothing to check against.";
  }
}

function usage(message: string): number {
  console.error(`${message}\n\n${USAGE}`);
  return 2;
}

// `exitCode`, not `exit()`: Node writes asynchronously to a pipe and synchronously
// to a file or TTY, so `process.exit()` drops everything past the first pending
// buffer and still exits 0 — and only `| cat` sees the truncation. Letting the loop
// drain is the whole fix. See docs/LESSONS_LEARNED.md §111.
const cliResult = main(process.argv.slice(2));
if (typeof cliResult === "number") {
  process.exitCode = cliResult;
} else {
  cliResult.then((code) => {
    process.exitCode = code;
  });
}
