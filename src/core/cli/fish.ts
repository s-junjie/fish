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
import { commandSpec, parseArgs, renderUsage } from "./command-spec";

const USAGE = `fish — the FISH agent CLI (nothing to install)

  ./fish --version [--check]
${renderUsage()}

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
  const spec = commandSpec(command);
  if (!spec) return usage(`unknown command "${command}"`);

  // Against the command's own table, so a flag the command does not read is
  // refused here instead of being parsed and then silently dropped.
  const parsed = parseArgs(rest, spec);
  if (!parsed.ok) return usage(parsed.message);

  const { values, positionals: args } = parsed.value;
  const valueOf = (name: string): string | undefined => {
    const value = values.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const numberOf = (name: string): number | undefined => {
    const value = valueOf(name);
    return value !== undefined ? Number(value) : undefined;
  };

  const opts = {
    json: values.has("--json"),
    strict: values.has("--strict"),
    geometry: values.has("--geometry"),
    audit: values.has("--audit"),
    strictAssets: values.has("--strict-assets"),
    page: valueOf("--page"),
    allPages: values.has("--all-pages"),
    compact: values.has("--compact"),
    embed: values.has("--embed"),
    all: values.has("--all"),
    replace: values.has("--replace"),
    out: valueOf("--out"),
    format: valueOf("--format"),
    scale: numberOf("--scale"),
    element: valueOf("--element"),
    source: valueOf("--source"),
    limit: numberOf("--limit"),
    addTo: valueOf("--add-to"),
    to: valueOf("--to"),
    pick: numberOf("--pick"),
    id: valueOf("--id"),
    name: valueOf("--name"),
    viewport: numberOf("--viewport"),
    viewportHeight: numberOf("--viewport-height"),
    template: valueOf("--template"),
    auditTolerance: auditToleranceOf(valueOf("--audit-tolerance")),
    summary: valueOf("--summary"),
    ops: valueOf("--ops"),
    reply: valueOf("--reply"),
    text: valueOf("--text")
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
// drain is the whole fix.
const cliResult = main(process.argv.slice(2));
if (typeof cliResult === "number") {
  process.exitCode = cliResult;
} else {
  cliResult.then((code) => {
    process.exitCode = code;
  });
}
