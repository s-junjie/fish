/**
 * The command table is the only place a flag can be declared, so these tests read
 * the table rather than restating it: a flag added to a form and forgotten in the
 * usage line fails here, and so does the reverse.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { COMMANDS, commandSpec, formLine, parseArgs, renderUsage } from "../src/core/cli/command-spec";
import type { ParsedArgs } from "../src/core/cli/command-spec";

function parse(command: string, rest: string[]): ParsedArgs {
  const spec = commandSpec(command);
  if (!spec) throw new Error(`no such command: ${command}`);
  const result = parseArgs(rest, spec);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function refusal(command: string, rest: string[]): string {
  const spec = commandSpec(command);
  if (!spec) throw new Error(`no such command: ${command}`);
  const result = parseArgs(rest, spec);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify([...result.value.values])}`);
  return result.message;
}

describe("the flag table", () => {
  it("declares and renders the same flags for every form", () => {
    const usage = renderUsage();
    for (const spec of COMMANDS) {
      for (const form of spec.forms) {
        const line = formLine(form);
        expect(usage).toContain(line);
        expect(new Set(line.match(/--[a-z-]+/g) ?? [])).toEqual(new Set(form.flags.map((flag) => flag.name)));
      }
    }
  });

  it("gives every command a one-line description", () => {
    const usage = renderUsage();
    for (const spec of COMMANDS) {
      expect(spec.desc.length).toBeGreaterThan(0);
      expect(usage).toContain(spec.desc.split("\n")[0]);
    }
  });
});

describe("parsing a command's own flags", () => {
  it("keeps a flag's value out of the positionals", () => {
    expect(parse("export", ["doc.fish.html", "--scale", "2", "--out", "out.png"])).toEqual({
      values: new Map<string, string | true>([
        ["--scale", "2"],
        ["--out", "out.png"]
      ]),
      positionals: ["doc.fish.html"]
    });
  });

  it("answers to the short spelling under the canonical name", () => {
    expect(parse("compact", ["doc.fish.html", "-o", "out.html"]).values.get("--out")).toBe("out.html");
  });

  it("reads a bare dash as stdin, not a flag", () => {
    expect(parse("compose", ["-", "templates/blank.fish.html"]).positionals).toEqual([
      "-",
      "templates/blank.fish.html"
    ]);
  });

  it("refuses a flag the command does not declare", () => {
    expect(refusal("check", ["doc.fish.html", "--format", "svg"])).toBe('unknown option "--format" for check');
  });

  it("refuses a misspelled flag instead of eating its value", () => {
    expect(refusal("check", ["doc.fish.html", "--scael", "3"])).toBe('unknown option "--scael" for check');
  });

  it("refuses a declared flag that needs a value and did not get one", () => {
    expect(refusal("export", ["doc.fish.html", "--format"])).toBe("--format needs a value");
  });
});

describe("sub-actions declare their own flags", () => {
  it("keeps an embed flag out of the listing form", () => {
    expect(refusal("assets", ["doc.fish.html", "--id", "asset_1"])).toBe(
      'option "--id" is not accepted by "fish assets <doc.fish.html | doc.json>"'
    );
  });

  it("keeps an embed flag out of the search form", () => {
    expect(refusal("assets", ["search", "coffee", "--id", "asset_1"])).toBe(
      'option "--id" is not accepted by "fish assets search <query>"'
    );
  });

  it("accepts it on the form that owns it", () => {
    expect(parse("assets", ["embed", "doc.fish.html", "--id", "asset_1"]).values.get("--id")).toBe("asset_1");
  });

  it("keeps a reply flag out of the listing form", () => {
    expect(refusal("comments", ["list", "doc.fish.html", "--text", "hi"])).toBe(
      'option "--text" is not accepted by "fish comments list|pending <doc.fish.html>"'
    );
  });
});

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "dist/fish-agent-kit/tools/fish.cjs");
const kitBuilt = fs.existsSync(cli);

function runCli(args: string[]): { code: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FISH_NO_UPDATE_CHECK: "1" }
    });
    return { code: 0, out: stdout };
  } catch (err: any) {
    return { code: typeof err?.status === "number" ? err.status : -1, out: `${err?.stdout ?? ""}${err?.stderr ?? ""}` };
  }
}

describe("the built kit answers the same way", () => {
  (kitBuilt ? it : it.skip)("refuses an undeclared flag before touching the file", () => {
    const res = runCli(["check", "no-such-file.fish.html", "--format", "svg"]);
    expect(res.code).toBe(2);
    expect(res.out).toContain('unknown option "--format"');
  });

  (kitBuilt ? it : it.skip)("prints the usage line the table renders", () => {
    const res = runCli(["--help"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(formLine(commandSpec("export")!.forms[0]));
  });
});
