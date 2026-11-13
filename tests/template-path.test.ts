import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTemplatePath } from "../src/core/cli/template-path";

const home = process.cwd();
afterEach(() => process.chdir(home));

function kit(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fish-kit-"));
  fs.mkdirSync(path.join(root, "templates"));
  fs.writeFileSync(path.join(root, "templates/blank.fish.html"), "<html></html>");
  fs.mkdirSync(path.join(root, "tools"));
  return root;
}

/** `os.tmpdir()` is a symlink on macOS; compare the physical paths. */
function found(template: string, script: string): string | null {
  const hit = resolveTemplatePath(template, script);
  return hit ? fs.realpathSync(hit) : null;
}

describe("resolveTemplatePath", () => {
  it("finds the shell beside tools/ when the caller stands elsewhere", () => {
    const root = kit();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "fish-project-"));
    process.chdir(project);

    expect(found("templates/blank.fish.html", path.join(root, "tools/fish.cjs"))).toBe(
      fs.realpathSync(path.join(root, "templates/blank.fish.html"))
    );
  });

  it("prefers the caller's own shell over the kit's", () => {
    const root = kit();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "fish-project-"));
    fs.mkdirSync(path.join(project, "templates"));
    fs.writeFileSync(path.join(project, "templates/blank.fish.html"), "<html>project</html>");
    process.chdir(project);

    expect(found("templates/blank.fish.html", path.join(root, "tools/fish.cjs"))).toBe(
      fs.realpathSync(path.join(project, "templates/blank.fish.html"))
    );
  });

  it("returns null when nobody has a shell", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "fish-project-"));
    process.chdir(project);

    expect(found("nope.fish.html", path.join(project, "tools/fish.cjs"))).toBeNull();
  });
});
