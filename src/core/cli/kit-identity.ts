import fs from "node:fs";
import path from "node:path";
import { LATEST_DOCUMENT_VERSION } from "../dsl/version";
import { APP_VERSION } from "../version";

/**
 * Who this copy of the kit thinks it is, read from the `SKILL.md` beside it.
 *
 * The skill is installed once and outlives every release after it: nothing on the
 * user's machine refreshes it when the app updates itself, so the prose an agent
 * follows can be several versions behind the engine it is driving. The two
 * numbers in the frontmatter are the only way to tell from the inside — they are
 * rendered from `package.json` and `versions.json` by the same build that
 * compiles this file, so a disagreement is never a typo, it is two releases
 * wearing one directory.
 */
export type SkillIdentity = { version?: string; documentDialect?: string };

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(frontmatter);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  return raw.replace(/^["']|["']$/g, "");
}

export function parseSkillIdentity(text: string): SkillIdentity {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return {
    version: frontmatterValue(frontmatter, "version"),
    documentDialect: frontmatterValue(frontmatter, "documentDialect")
  };
}

export type KitIdentity =
  | { status: "absent" }
  | { status: "unjudged" }
  | { status: "ok" }
  | { status: "mismatch"; message: string };

/**
 * `unjudged` is not a pass: it means this copy cannot answer the question — a
 * checkout whose `SKILL.md` still carries `{{TOKEN}}` placeholders, or a `dev`
 * build that has never been a release. Silence is right there; a warning an
 * author cannot act on is the one that trains people to ignore warnings.
 */
export function kitIdentityCheck(
  kitRoot: string,
  expected: { app: string; dialect: string } = { app: APP_VERSION, dialect: LATEST_DOCUMENT_VERSION }
): KitIdentity {
  const skillPath = path.join(kitRoot || ".", "SKILL.md");
  if (!kitRoot || !fs.existsSync(skillPath)) return { status: "absent" };

  const identity = parseSkillIdentity(fs.readFileSync(skillPath, "utf8"));
  const { version, documentDialect } = identity;
  if (!version || !documentDialect) return { status: "unjudged" };
  if (version.includes("{{") || documentDialect.includes("{{")) return { status: "unjudged" };
  if (expected.app === "dev") return { status: "unjudged" };
  if (version === expected.app && documentDialect === expected.dialect) return { status: "ok" };

  return {
    status: "mismatch",
    message:
      `this kit is not one release: SKILL.md describes FISH ${version} (dialect ${documentDialect}), ` +
      `while tools/fish is ${expected.app} (dialect ${expected.dialect}).\n` +
      `  Nothing was run — the instructions and the engine disagree, so one of them is wrong about every op.\n` +
      `  Re-install the skill (SKILL.md § "Get the kit") instead of editing either number.`
  };
}

/** `tools/fish.cjs` resolves its own directory, so the kit root is its parent. */
export function kitRootOf(entry: string | undefined): string {
  return entry ? path.resolve(path.dirname(entry), "..") : "";
}
