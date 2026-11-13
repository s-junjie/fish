/**
 * The command table: the one place that says what each `fish` command accepts.
 *
 * `dispatch` parses against it and `USAGE` is rendered from it, so a flag cannot
 * be accepted without being documented, or documented without being accepted.
 * Arity is part of the declaration because a value-taking flag consumes the next
 * token — that is what decides whether a token is an argument or an operand.
 *
 * Before this table, the same flag names were written three times (the `getOpt`
 * calls, the positional-skip list, the usage text) and drifted: `--format` was
 * parsed and rejected in `export`, and listed nowhere.
 */

export interface FlagSpec {
  /** Canonical spelling; `short` is an alias for the same flag. */
  name: string;
  short?: string;
  arity: 0 | 1;
  /** How it reads in the usage line. Defaults to `name`. */
  display?: string;
  /** Rendered without brackets: the command cannot run without it. */
  required?: boolean;
}

export interface FormSpec {
  /** Everything between `./fish ` and the flags. */
  head: string;
  /** The sub-action words this form answers to; the bare form omits them. */
  verbs?: string[];
  flags: FlagSpec[];
  /** For a shape `[--x]` items cannot express — `(--id A | --all)`. */
  syntax?: string;
}

export interface CommandSpec {
  name: string;
  desc: string;
  forms: FormSpec[];
}

const on = (name: string): FlagSpec => ({ name, arity: 0 });

const of = (name: string, display: string, required = false): FlagSpec => ({
  name,
  arity: 1,
  display,
  required
});

const OUT = { name: "--out", short: "-o", arity: 1, display: "-o|--out FILE" } as const satisfies FlagSpec;

const DOC = "<doc.fish.html | doc.json>";

export const COMMANDS: CommandSpec[] = [
  {
    name: "check",
    desc: "normalize + validate the document block and print what the engine would change.",
    forms: [
      {
        head: `check ${DOC}`,
        flags: [
          on("--json"),
          on("--strict"),
          on("--geometry"),
          on("--audit"),
          of("--audit-tolerance", "--audit-tolerance N"),
          on("--strict-assets")
        ]
      }
    ]
  },
  {
    name: "brief",
    desc: "report the tokens, styles, components, assets and fonts the document already carries.",
    forms: [{ head: `brief ${DOC}`, flags: [on("--json")] }]
  },
  {
    name: "inspect",
    desc: `report ONE element: the box it actually got, its effective style, its parents,
         and — for an instance — the slots its overrides may address.`,
    forms: [{ head: `inspect <elementId> ${DOC}`, flags: [on("--all"), on("--json")] }]
  },
  {
    name: "compact",
    desc: "emit the canonical compact JSON of a document, assets preserved.",
    forms: [{ head: `compact ${DOC}`, flags: [OUT] }]
  },
  {
    name: "assets",
    desc: "inspect doc.assets[] with the size each one costs; search, import or embed.",
    forms: [
      { head: `assets ${DOC}`, flags: [on("--json")] },
      {
        head: "assets search <query>",
        verbs: ["search"],
        flags: [
          of("--source", "--source openverse|lucide|ri"),
          of("--limit", "--limit N"),
          of("--add-to", "--add-to <doc>"),
          of("--pick", "--pick N"),
          on("--embed"),
          of("--to", "--to <elementId>"),
          on("--replace"),
          on("--json")
        ]
      },
      {
        head: "assets import <file...> <doc.fish.html>",
        verbs: ["import"],
        flags: [of("--name", "--name N"), of("--to", "--to <elementId>"), on("--replace"), on("--json")]
      },
      {
        head: "assets embed <doc.fish.html>",
        verbs: ["embed"],
        flags: [of("--id", "--id <assetId>"), on("--all"), on("--json")],
        syntax: "assets embed <doc.fish.html> (--id <assetId> | --all) [--json]"
      }
    ]
  },
  {
    name: "apply",
    desc: "run the macro-ops of the authoring guide against the document block, in place.",
    forms: [
      {
        head: `apply <ops.json | '[{"op":"patch",...}]'> <doc.fish.html>`,
        flags: [OUT, on("--compact"), on("--json")]
      }
    ]
  },
  {
    name: "comments",
    desc: 'read a thread and its local context, and write a suggestion back into the "#fish-comments" block.',
    forms: [
      { head: "comments list|pending <doc.fish.html>", verbs: ["list", "pending"], flags: [on("--json")] },
      { head: "comments context <doc.fish.html> <threadId>", verbs: ["context"], flags: [] },
      {
        head: "comments suggest <doc.fish.html> <threadId>",
        verbs: ["suggest"],
        flags: [of("--summary", "--summary <text>", true), of("--ops", "--ops <ops.json|'[...]'>", true)]
      },
      { head: "comments reply <doc.fish.html> <threadId>", verbs: ["reply"], flags: [of("--text", "--text <text>", true)] },
      { head: "comments resolve <doc.fish.html> <threadId>", verbs: ["resolve"], flags: [of("--reply", "--reply <text>")] }
    ]
  },
  {
    name: "import",
    desc: "measure a page in a real browser and emit an editable document.",
    forms: [
      {
        head: "import <page.html>",
        flags: [
          OUT,
          of("--viewport", "--viewport N"),
          of("--viewport-height", "--viewport-height N"),
          of("--name", "--name N"),
          of("--template", "--template FILE"),
          on("--compact"),
          on("--json")
        ]
      }
    ]
  },
  {
    name: "compose",
    desc: "inject a design.json into the shell without regex pitfalls or string corruption.",
    forms: [{ head: "compose <design.json | -> <template.fish.html>", flags: [OUT, on("--compact")] }]
  },
  {
    name: "export",
    desc: "render a PNG of a document through a headless browser (PNG only).",
    forms: [
      {
        head: "export <doc.fish.html>",
        flags: [OUT, of("--scale", "--scale N"), of("--element", "--element ID"), of("--format", "--format png")]
      }
    ]
  }
];

const BY_NAME = new Map(COMMANDS.map((spec) => [spec.name, spec]));

export const commandSpec = (name: string): CommandSpec | undefined => BY_NAME.get(name);

export interface ParsedArgs {
  /** Keyed by the canonical `FlagSpec.name`, whatever spelling was used. */
  values: Map<string, string | true>;
  positionals: string[];
}

export type ParseResult = { ok: true; value: ParsedArgs } | { ok: false; message: string };

function flagIndex(spec: CommandSpec): Map<string, FlagSpec> {
  const index = new Map<string, FlagSpec>();
  for (const form of spec.forms) {
    for (const flag of form.flags) {
      index.set(flag.name, flag);
      if (flag.short) index.set(flag.short, flag);
    }
  }
  return index;
}

function resolveForm(spec: CommandSpec, positionals: string[]): FormSpec {
  const verb = positionals[0];
  return (
    spec.forms.find((form) => form.verbs?.includes(verb)) ??
    spec.forms.find((form) => !form.verbs) ??
    spec.forms[0]
  );
}

export function parseArgs(rest: string[], spec: CommandSpec): ParseResult {
  const index = flagIndex(spec);
  const values: ParsedArgs["values"] = new Map();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    // A bare `-` is stdin (`compose`), not a flag.
    if (token.length < 2 || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const flag = index.get(token);
    if (!flag) return { ok: false, message: `unknown option "${token}" for ${spec.name}` };
    if (flag.arity === 0) {
      values.set(flag.name, true);
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined) return { ok: false, message: `${token} needs a value` };
    values.set(flag.name, next);
    i += 1;
  }

  // Which sub-action was asked for decides which flags are legal, so this check
  // runs after the verb is known rather than against the command's whole surface.
  const form = resolveForm(spec, positionals);
  for (const name of values.keys()) {
    if (!form.flags.some((flag) => flag.name === name)) {
      return { ok: false, message: `option "${name}" is not accepted by "fish ${form.head}"` };
    }
  }

  return { ok: true, value: { values, positionals } };
}

function flagsOf(form: FormSpec): string {
  return form.flags
    .map((flag) => {
      const body = flag.display ?? flag.name;
      return ` ${flag.required ? body : `[${body}]`}`;
    })
    .join("");
}

export function formLine(form: FormSpec): string {
  return `  ./fish ${form.syntax ?? `${form.head}${flagsOf(form)}`}`;
}

export function renderUsage(): string {
  const lines = COMMANDS.flatMap((spec) => spec.forms.map(formLine));
  const descriptions = COMMANDS.map((spec) => `${spec.name.padEnd(9)}${spec.desc}`);
  return `${lines.join("\n")}\n\n${descriptions.join("\n")}`;
}
