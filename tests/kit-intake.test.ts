import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { projectContext, contextReport } from "../src/core/cli/fish-brief";
import { SKILL_REFERENCES } from "../scripts/lib/skill-render.mjs";

/**
 * The kit's gate before the first element: intent is written beside the
 * document, and the directory is recon rather than a usage error. These grade
 * the two things an agent actually touches — the command it runs on an empty
 * folder, and the index that makes the intake readable.
 */
const ROOT = path.resolve(__dirname, "..");
const FISH = path.join(ROOT, "dist/fish-agent-kit/tools/fish.cjs");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fish-intake-"));
}

function withDir(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = tmpdir();
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("the directory a design starts in", () => {
  it("names the intent record and the material already there", () => {
    withDir({ "intent.md": "# Brief\n", "logo.svg": "<svg/>", "notes.txt": "not material" }, (dir) => {
      const ctx = projectContext(dir);
      expect(ctx.intent).toBe(path.join(dir, "intent.md"));
      expect(ctx.material.map((m) => m.name)).toEqual(["logo.svg"]);

      const report = contextReport(ctx, "new");
      expect(report).toContain("intent.md");
      expect(report).toContain("logo.svg");
      expect(report).not.toContain("notes.txt");
    });
  });

  // The one state a new design is in. A report that says "none" without saying
  // what to write leaves the agent to invent the shape.
  it("asks for the intent record when the directory holds nothing", () => {
    withDir({}, (dir) => {
      const report = contextReport(projectContext(dir), "new");
      expect(report).toContain("no document yet");
      expect(report).toContain("write intent.md");
      expect(report).toContain("none here");
    });
  });

  it("reports beside the document in document mode", () => {
    const ctx = { intent: "/p/intent.md", material: [] };
    expect(contextReport(ctx, "doc")).toContain("beside the document");
    expect(contextReport(ctx, "doc")).toContain("/p/intent.md");
  });
});

describe("the intake is reachable from the entry point", () => {
  const skill = fs.readFileSync(path.join(ROOT, "agent-kit/SKILL.md"), "utf-8");

  // SKILL_REFERENCES is the single list of published references; the index is
  // hand-written prose. A reference the index never names is a file an agent
  // will not open, which is the same as not shipping it.
  it("indexes every reference the kit publishes", () => {
    for (const name of SKILL_REFERENCES) {
      expect(skill, `SKILL.md never names references/${name}`).toContain(`references/${name}`);
    }
  });

  it("states the gate as a hard rule, not a suggestion", () => {
    expect(skill).toContain("before you decide what it looks like");
    expect(skill).toContain("intent.md");
  });
});

const whenBuilt = fs.existsSync(FISH) ? it : it.skip;

whenBuilt("fish brief with no document answers the directory", () => {
  withDir({ "intent.md": "# Brief\n", "brand-manual.pdf": "%PDF-1.4" }, (dir) => {
    const out = execFileSync(process.execPath, [FISH, "brief"], { cwd: dir, encoding: "utf-8" });
    expect(out).toContain("no document yet");
    expect(out).toContain("intent.md");
    expect(out).toContain("brand-manual.pdf");
  });
});
