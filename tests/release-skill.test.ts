import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderSkill, skillVariables, SKILL_REFERENCES } from "../scripts/lib/skill-render.mjs";

/**
 * `SKILL.md` is both an archive member and a published page, and only the page
 * can carry the archive's own digest. These grade the renderings against each
 * other so the two copies cannot drift into two different skill descriptions.
 */
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "agent-kit/SKILL.md"), "utf-8");
const origin = "https://dl.fish.themindstudio.cc";
const version = "0.1.0";
const kitFile = `kit/fish-agent-kit-${version}.zip`;
const digest = "0".repeat(64);

const hosted = renderSkill(source, skillVariables({ origin, version, kitFile, kitSha256: digest, hosted: true }));
const archive = renderSkill(
  source,
  skillVariables({ origin, version, kitFile, kitUrl: `${origin}/${kitFile}` })
);

describe("the skill page is the entry point an agent can @", () => {
  it("keeps the frontmatter the skills CLI discovers", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "";
    expect(frontmatter).toContain("name: fish-design");
    expect(frontmatter).toMatch(/description: \S/);
  });

  it("resolves every placeholder in both renderings", () => {
    for (const text of [hosted, archive]) expect(text).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  it("pins the archive digest on the page, which is written after packing", () => {
    expect(hosted).toContain(digest);
    // The archive cannot contain its own hash; it must point at the index instead.
    expect(archive).not.toContain(digest);
    expect(archive).toContain("sha256sums.txt");
  });

  it("links every reference it publishes, by absolute URL", () => {
    for (const name of SKILL_REFERENCES) {
      expect(fs.existsSync(path.join(root, "agent-kit/references", name)), `agent-kit/references/${name} is missing`).toBe(
        true
      );
      expect(hosted).toContain(`${origin}/skill/${version}/references/${name}`);
      expect(archive).not.toContain(`${origin}/skill/${version}/references/${name}`);
    }
  });

  it("publishes every reference the kit ships", () => {
    const shipped = fs.readdirSync(path.join(root, "agent-kit/references")).sort();
    expect(shipped).toEqual([...SKILL_REFERENCES].sort());
  });

  it("does not rely on an executable bit the installer drops", () => {
    for (const text of [hosted, archive]) {
      expect(text).toContain("chmod +x tools/fish");
      expect(text).toContain("node tools/fish.cjs");
    }
  });

  it("names the stable pointers an update can follow", () => {
    for (const text of [hosted, archive]) {
      expect(text).toContain(`${origin}/stable/fish-agent-kit.zip`);
      expect(text).toContain(`${origin}/skill.md`);
    }
  });
});
