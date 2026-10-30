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
// Both axes are read from their single source: a test that hard-codes them goes
// stale on the next bump and stops grading the thing it was written for.
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;
const docVersion = JSON.parse(fs.readFileSync(path.join(root, "src/core/dsl/versions.json"), "utf-8")).current;
const kitFile = `kit/fish-agent-kit-${version}.zip`;
const digest = "0".repeat(64);

const hosted = renderSkill(
  source,
  skillVariables({ origin, version, docVersion, kitFile, kitSha256: digest, hosted: true })
);
const archive = renderSkill(
  source,
  skillVariables({ origin, version, docVersion, kitFile, kitUrl: `${origin}/${kitFile}` })
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

  /**
   * A skill installed into a global directory outlives the release that made it.
   * The copy has to say which engine it was written for, or an agent cannot tell
   * a stale instruction from a current one — and the number must come from the
   * build, not from the author's memory.
   */
  it("says which FISH it describes, from the single version source", () => {
    for (const text of [hosted, archive]) {
      expect(text).toContain(`for FISH ${version}`);
      expect(text).toContain(`document dialect ${docVersion}`);
    }
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(hosted)?.[1] ?? "";
    expect(frontmatter).toContain(`version: "${version}"`);
    expect(frontmatter).toContain(`documentDialect: "${docVersion}"`);
    expect(hosted).toContain("tools/fish --version");
  });

  it("refuses to render a version-less skill", () => {
    expect(() => skillVariables({ origin, version: "", docVersion, kitFile })).toThrow(/app version/);
    expect(() => skillVariables({ origin, version, docVersion: "", kitFile })).toThrow(/document dialect/);
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
