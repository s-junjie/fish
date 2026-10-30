import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The kit is a download, not a repo checkout. These tests grade the thing an
 * external agent actually runs: the CLI, the blank template and the launcher.
 * They deliberately say nothing about which docs exist or where they live.
 */
const REPO = path.resolve(__dirname, "..");
const KIT = path.join(REPO, "dist/fish-agent-kit");
const FISH = path.join(KIT, "tools/fish.cjs");
const LAUNCHER = path.join(KIT, "tools/fish");
const TEMPLATE = path.join(KIT, "templates/blank.fish.html");

const built = [FISH, LAUNCHER, TEMPLATE].every((file) => fs.existsSync(file));
const whenBuilt = built ? describe : describe.skip;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fish-kit-"));
}

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [FISH, ...args], {
    cwd: tmpdir(),
    input,
    encoding: "utf-8",
    timeout: 20_000
  });
}

whenBuilt("the downloaded kit runs on its own", () => {
  it("checks the shipped blank document", () => {
    const report = JSON.parse(run(["check", TEMPLATE, "--json"]));
    expect(report.ok).toBe(true);
  });

  it("composes from stdin and checks the result", () => {
    const out = path.join(tmpdir(), "draft.fish.html");
    const doc = {
      version: "0.1",
      name: "Smoke",
      canvas: { width: 400, height: 300 },
      elements: [{ id: "title", type: "text", content: "Hello", style: "700 24 Inter #FFFFFF" }]
    };
    run(["compose", "-", TEMPLATE, "--out", out, "--compact"], JSON.stringify(doc));
    const report = JSON.parse(run(["check", out, "--json"]));
    expect(report.ok).toBe(true);
  });

  it("runs the launcher, which is the command every instruction names", () => {
    const help = execFileSync(LAUNCHER, ["--help"], { cwd: tmpdir(), encoding: "utf-8" });
    expect(help).toContain("assets");
    expect(help).toContain("check");
  });

  it("rejects an unknown source without reaching the network", () => {
    const result = spawnSync(
      process.execPath,
      [FISH, "assets", "search", "anything", "--source", "not-a-source"],
      { cwd: tmpdir(), encoding: "utf-8", timeout: 20_000 }
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown asset source");
  });

  // The kit's `SKILL.md` tells an agent to compare this number against the one
  // it was written for. If the bundle is not stamped, that instruction is a dead
  // end — the CLI would print "dev".
  it("answers --version with the version the skill was written for", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8"));
    expect(run(["--version"]).trim()).toBe(`fish ${pkg.version}`);
  });
});
