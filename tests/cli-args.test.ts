/**
 * The command table is the only place a flag can be declared, so these tests read
 * the table rather than restating it: a flag added to a form and forgotten in the
 * usage line fails here, and so does the reverse.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
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

  it("parses the single-key contract lookup", () => {
    expect(parse("schema", ["fit", "--json"])).toEqual({
      values: new Map<string, string | true>([["--json", true]]),
      positionals: ["fit"]
    });
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

  (kitBuilt ? it : it.skip)("answers one key without dumping the whole contract", () => {
    const res = runCli(["schema", "fit", "--json"]);
    expect(res.code).toBe(0);
    const report = JSON.parse(res.out);
    const owners = report.matches.map((match: { definition: string }) => match.definition);
    expect(owners).toContain("DesignElement");
    expect(owners).toContain("Paint");
    expect(res.out.length).toBeLessThan(4000);
  });

  (kitBuilt ? it : it.skip)("publishes one spelling and resolves aliases to it", () => {
    const published = runCli(["schema", "border-radius", "--json"]);
    expect(published.code).toBe(0);
    const direct = JSON.parse(published.out);
    expect(direct.alias).toBe(false);
    expect(direct.published).toBe("border-radius");
    expect(direct.matches.every((match: { key: string }) => match.key === "border-radius")).toBe(true);

    const alias = runCli(["schema", "borderRadius", "--json"]);
    expect(alias.code).toBe(0);
    const resolved = JSON.parse(alias.out);
    expect(resolved.alias).toBe(true);
    expect(resolved.published).toBe("border-radius");
    expect(resolved.matches.length).toBeGreaterThan(0);
  });

  (kitBuilt ? it : it.skip)("refuses an unknown key", () => {
    expect(runCli(["schema", "no-such-key-xyz"]).code).toBe(1);
    const conflict = runCli(["schema", "fit", "--find", "gradient"]);
    expect(conflict.code).toBe(2);
  });

  (kitBuilt ? it : it.skip)("lists compact definitions and keys without prior knowledge", () => {
    const bare = runCli(["schema"]);
    expect(bare.code).toBe(0);
    expect(bare.out.length).toBeLessThan(6500);
    expect(bare.out).toContain("DesignDocument:");
    expect(bare.out).toContain("Paint:");
    expect(bare.out).toContain("DesignToken:");
    expect(bare.out).toContain("BlendMode [enum]:");

    const listed = runCli(["schema", "--list", "--json"]);
    expect(listed.code).toBe(0);
    const catalog = JSON.parse(listed.out);
    const names = catalog.definitions.map((entry: { name: string }) => entry.name);
    expect(names).toContain("DesignDocument");
    expect(names).toContain("DesignElement");
    expect(names).toContain("Tear");
  });

  (kitBuilt ? it : it.skip)("looks up non-element, oneOf, nested, definition, and colliding keys", () => {
    for (const [key, expectedDef] of [
      ["tokens", "DesignDocument"],
      ["transition", "SlideSpec"],
      ["category", "DesignToken"],
      ["columnSpan", "DesignElement.grid-area"],
      ["presentBackground", "DesignDocument.canvas"],
      ["paint", "Stroke"]
    ] as const) {
      const res = runCli(["schema", key, "--json"]);
      expect(res.code).toBe(0);
      const report = JSON.parse(res.out);
      expect(report.published).toBe(key);
      expect(report.alias).toBe(false);
      expect(report.matches.map((m: { definition: string }) => m.definition)).toContain(expectedDef);
    }

    const defRes = runCli(["schema", "Paint", "--json"]);
    expect(defRes.code).toBe(0);
    const defReport = JSON.parse(defRes.out);
    expect(defReport.definition).toBe("Paint");
    expect(defReport.matches.map((m: { key: string }) => m.key)).toContain("focalPoint");

    const focal = runCli(["schema", "focalPoint", "--json"]);
    expect(focal.code).toBe(0);
    const focalReport = JSON.parse(focal.out);
    expect(focalReport.absorbed).toBe(true);
    expect(focalReport.matches.map((m: { definition: string }) => m.definition)).toContain("Paint");

    const fontSize = runCli(["schema", "fontSize", "--json"]);
    expect(fontSize.code).toBe(0);
    const fontReport = JSON.parse(fontSize.out);
    expect(fontReport.alias).toBe(true);
    expect(fontReport.published).toBe("font-size");
    const fontOwners = fontReport.matches.map((m: { definition: string; key: string }) => `${m.definition}.${m.key}`);
    expect(fontOwners).toContain("TextStyle.fontSize");
    expect(fontOwners).toContain("DesignElement.font-size");
  });

  (kitBuilt ? it : it.skip)("searches schema descriptions, keys, and enums with --find", () => {
    const res = runCli(["schema", "--find", "gradient", "--json"]);
    expect(res.code).toBe(0);
    const report = JSON.parse(res.out);
    expect(report.matches.length).toBeGreaterThan(0);
    expect(report.matches.some((m: { definition: string }) => m.definition === "Paint")).toBe(true);
    expect(runCli(["schema", "--find", "no-such-term-xyz"]).code).toBe(1);
  });

  (kitBuilt ? it : it.skip)("supports --page and --all-pages on check", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fish-check-pages-"));
    try {
      const docPath = path.join(tmp, "multi.json");
      fs.writeFileSync(
        docPath,
        JSON.stringify({
          version: "0.1",
          activePageId: "p1",
          pages: [
            {
              id: "p1",
              name: "Cover",
              canvas: { width: 400, height: 400 },
              children: [{ id: "ok_box", type: "rect", x: 0, y: 0, width: 40, height: 40 }]
            },
            {
              id: "p2",
              name: "Second",
              canvas: { width: 400, height: 400 },
              children: [
                {
                  id: "parent_box",
                  type: "frame",
                  x: 0,
                  y: 0,
                  width: 50,
                  height: 50,
                  display: "flex",
                  children: [{ id: "tall_child", type: "rect", width: 80, height: 80 }]
                }
              ]
            }
          ]
        })
      );

      const p1 = runCli(["check", docPath, "--geometry", "--json"]);
      expect(p1.code).toBe(0);
      expect(JSON.parse(p1.out).geometry).toEqual([]);

      const p2 = runCli(["check", docPath, "--page", "p2", "--geometry", "--json"]);
      expect(p2.code).toBe(0);
      const p2Json = JSON.parse(p2.out);
      expect(p2Json.page).toEqual({ id: "p2", name: "Second" });
      expect(p2Json.geometry.length).toBeGreaterThan(0);

      const all = runCli(["check", docPath, "--all-pages", "--geometry", "--json"]);
      expect(all.code).toBe(0);
      const allJson = JSON.parse(all.out);
      expect(allJson.pages.map((p: any) => p.id)).toEqual(["p1", "p2"]);
      expect(allJson.geometry.length).toBeGreaterThan(0);

      const missing = runCli(["check", docPath, "--page", "missing_page"]);
      expect(missing.code).toBe(2);

      const conflict = runCli(["check", docPath, "--page", "p1", "--all-pages"]);
      expect(conflict.code).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  (kitBuilt ? it : it.skip)("shot.sh refuses unknown flags instead of treating them as output paths", () => {
    const shotPath = path.join(root, "dist/fish-agent-kit/tools/shot.sh");
    try {
      execFileSync("bash", [shotPath, "doc.fish.html", "out.png", "--unknown-flag"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      throw new Error("expected shot.sh to exit non-zero");
    } catch (err: any) {
      expect(err.status).toBe(2);
      expect(String(err.stderr ?? "")).toContain("unknown option");
    }
  });
});
