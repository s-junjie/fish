import fs from "node:fs";
import path from "node:path";

/**
 * Where a shell template lives when the CLI is run from a project directory.
 *
 * A kit ships `templates/` beside `tools/`, so `tools/fish.cjs` has to look one
 * level up. Anchoring the search on the script's own directory alone sent every
 * `compose <design.json> --out …` to `<kit>/tools/templates/…`, which does not
 * exist — the command only worked when the caller happened to stand in the kit
 * root. The caller's cwd stays first: a project may bring its own shell.
 */
export function resolveTemplatePath(templateFile: string, script: string | undefined = process.argv[1]): string | null {
  if (fs.existsSync(templateFile)) return path.resolve(templateFile);
  const roots = [process.cwd(), ...(script ? [path.dirname(script), path.dirname(path.dirname(script))] : [])];
  const wanted = path.basename(templateFile);
  const relatives = [
    templateFile,
    path.join("templates", wanted),
    path.join("templates", "blank.fish.html"),
    wanted,
    "blank.fish.html"
  ];
  for (const root of roots) {
    for (const rel of relatives) {
      const candidate = path.resolve(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
