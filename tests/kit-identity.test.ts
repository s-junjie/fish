import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kitIdentityCheck, kitRootOf, parseSkillIdentity } from "../src/core/cli/kit-identity";
import { dialectMismatch, readDocument } from "../src/core/cli/doc-source";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";

/**
 * An installed skill outlives the release that made it: nothing refreshes it when
 * the app updates itself. These grade the two claims that can be checked from
 * inside the kit — the prose and the engine are one release, and the document in
 * front of it speaks the same dialect — and they derive both versions from their
 * single source, because a rig that hard-codes today's number stops grading on
 * the next bump.
 */
const REPO = path.resolve(__dirname, "..");
const APP = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8")) as { version: string }).version;
const DIALECT = LATEST_DOCUMENT_VERSION;
const SAME_RELEASE = { app: APP, dialect: DIALECT };

const HEAD = "---\nname: fish-design\ndescription: create and verify FISH designs\nmetadata:\n";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fish-kit-identity-"));
}

/** A kit root as an installer leaves it: `SKILL.md` beside `tools/`. */
function kitWith(metadata: string, body = "# FISH Vector Design\n"): string {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "SKILL.md"), `${HEAD}${metadata}\n---\n\n${body}`);
  return root;
}

function rendered(version = APP, dialect = DIALECT, quote = '"'): string {
  return `  version: ${quote}${version}${quote}\n  documentDialect: ${quote}${dialect}${quote}`;
}

function documentFile(doc: unknown): string {
  const file = path.join(tmpdir(), "draft.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe("the kit can tell which release it is", () => {
  it("accepts a copy whose prose and engine were built together", () => {
    expect(kitIdentityCheck(kitWith(rendered()), SAME_RELEASE)).toEqual({ status: "ok" });
  });

  it("refuses a directory holding two releases, naming both", () => {
    const older = kitIdentityCheck(kitWith(rendered("0.0.1-notarelease")), SAME_RELEASE);
    expect(older.status).toBe("mismatch");
    expect(older.status === "mismatch" && older.message).toContain("0.0.1-notarelease");
    expect(older.status === "mismatch" && older.message).toContain(APP);
    expect(older.status === "mismatch" && older.message).toContain("Re-install");
  });

  it("refuses a kit whose prose describes another dialect, at the same version", () => {
    const drift = kitIdentityCheck(kitWith(rendered(APP, "0.0-notarelease")), SAME_RELEASE);
    expect(drift.status).toBe("mismatch");
    expect(drift.status === "mismatch" && drift.message).toContain(DIALECT);
  });

  it("says nothing about a kit it cannot judge", () => {
    const noSkill = tmpdir();
    expect(kitIdentityCheck(noSkill, SAME_RELEASE)).toEqual({ status: "absent" });
    expect(kitIdentityCheck("", SAME_RELEASE)).toEqual({ status: "absent" });
    // A checkout renders its SKILL.md at build time; before that it says nothing
    // answerable, and a warning an author cannot act on trains them to ignore it.
    expect(kitIdentityCheck(kitWith(rendered("{{SKILL_VERSION}}", "{{DOC_VERSION}}")), SAME_RELEASE)).toEqual({
      status: "unjudged"
    });
    expect(kitIdentityCheck(kitWith(rendered()), { app: "dev", dialect: DIALECT })).toEqual({ status: "unjudged" });
  });

  it("finds SKILL.md beside the tool that asked, not above the repository", () => {
    expect(kitRootOf("/opt/skills/fish-design/tools/fish.cjs")).toBe("/opt/skills/fish-design");
    expect(kitRootOf(undefined)).toBe("");
  });
});

describe("the frontmatter is read, not guessed", () => {
  it("takes the two keys under metadata, in either quoting", () => {
    expect(parseSkillIdentity(`${HEAD}${rendered("1.2.3", "0.9")}\n---\n`)).toEqual({
      version: "1.2.3",
      documentDialect: "0.9"
    });
    expect(parseSkillIdentity(`${HEAD}  version: 1.2.3\n  documentDialect: 0.9\n---\n`)).toEqual({
      version: "1.2.3",
      documentDialect: "0.9"
    });
  });

  it("does not mistake the top-level name for a version", () => {
    expect(parseSkillIdentity("---\nname: fish-design\n---\n")).toEqual({
      version: undefined,
      documentDialect: undefined
    });
    expect(parseSkillIdentity("no frontmatter at all")).toEqual({
      version: undefined,
      documentDialect: undefined
    });
  });
});

describe("a document from another dialect is refused, not translated", () => {
  it("passes the dialect this kit speaks", () => {
    expect(dialectMismatch({ version: DIALECT }, "d.json")).toBeNull();
    const read = readDocument(documentFile({ version: DIALECT, elements: [] }));
    expect("error" in read).toBe(false);
  });

  it("refuses in both directions, before anything is written", () => {
    const read = readDocument(documentFile({ version: "0.0-notarelease", elements: [] }));
    expect("error" in read && read.code).toBe(2);
    expect("error" in read && read.error).toContain("0.0-notarelease");
    expect("error" in read && read.error).toContain(DIALECT);
    expect("error" in read && read.error).toContain("Re-install");
  });

  it("leaves a version-less design alone, so `compose` still takes a fragment", () => {
    expect(dialectMismatch({ elements: [] }, "d.json")).toBeNull();
    expect(dialectMismatch({ version: "" }, "d.json")).toBeNull();
    expect(dialectMismatch(null, "d.json")).toBeNull();
  });
});
