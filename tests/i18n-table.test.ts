import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { flattenDictionary } from "../src/i18n/flatten";
import { getLanguage, registerLanguage, setLanguage, t } from "../src/i18n";
import { i18nIndexPlugin } from "../scripts/vite-plugin-i18n-index";

const { keys, values } = flattenDictionary(en as unknown as Record<string, unknown>);

const SOURCE_DIR = path.resolve(process.cwd(), "src");
const T_LITERAL = /\bt\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1(\s*[,)])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(ts|tsx)$/.test(entry.name) ? [file] : [];
  });
}

afterEach(() => {
  setLanguage("en");
});

describe("the flattened i18n table", () => {
  it("resolves every authored key through the shipped key table", () => {
    // A front-coding bug or a stale virtual table shows up as the raw path here,
    // not as a blank label in the UI.
    expect(keys.length).toBeGreaterThan(900);
    for (let index = 0; index < keys.length; index++) {
      expect(t(keys[index]), keys[index]).toBe(values[index]);
    }
  });

  it("interpolates variables and leaves unknown keys legible", () => {
    expect(t("updates.current", { v: "0.1.0" })).toBe("v0.1.0 is the latest version.");
    expect(t("does.notExist")).toBe("does.notExist");
  });

  it("keeps English when a locale omits a key", () => {
    registerLanguage("test-nested", { common: { cancel: "Annuler" } });
    setLanguage("test-nested");
    expect(t("common.cancel")).toBe("Annuler");
    expect(getLanguage()).toBe("test-nested");
    expect(t("common.add"), "a missing translation falls back to English").toBe("Add");

    registerLanguage("test-sparse", []);
    setLanguage("test-sparse");
    expect(t("common.close"), "a sparse value array falls back to English").toBe("Close");
    expect(t("does.notExist"), "an unknown key is still legible").toBe("does.notExist");
  });

  it("names a dictionary key at every literal t() call site", () => {
    // The build plugin raises this for the files it rewrites; this catches the
    // drift before a build, and in files (and comments) the plugin never sees.
    const known = new Set(keys);
    const missing: string[] = [];
    let checked = 0;
    for (const file of sourceFiles(SOURCE_DIR)) {
      const code = readFileSync(file, "utf-8");
      if (file.endsWith(path.join("i18n", "en.ts"))) continue;
      for (const match of code.matchAll(T_LITERAL)) {
        checked++;
        if (!known.has(match[2])) missing.push(`${path.relative(process.cwd(), file)}: ${match[2]}`);
      }
    }
    expect(checked, "the scan must find the call sites, not an empty regex match").toBeGreaterThan(1000);
    expect(missing).toEqual([]);
  });

  describe("i18nIndexPlugin transform", () => {
    it("rewrites both double-quoted and single-quoted t() calls to slot indices", () => {
      const plugin = i18nIndexPlugin();
      (plugin as any).configResolved({ command: "build", root: process.cwd() });
      const transform = (plugin as any).transform;

      const codeDouble = 'import { t } from "./i18n";\nconst msg = t("common.add");';
      const codeSingle = "import { t } from './i18n';\nconst msg = t('common.add');";
      const codeWithArgs = "import { t } from './i18n';\nconst msg = t('common.add', { count: 1 });";
      const filePath = path.resolve(process.cwd(), "src/ui/test.tsx");

      const resDouble = transform.call({}, codeDouble, filePath);
      const resSingle = transform.call({}, codeSingle, filePath);
      const resWithArgs = transform.call({}, codeWithArgs, filePath);

      expect(resDouble).not.toBeNull();
      expect(resSingle).not.toBeNull();
      expect(resWithArgs).not.toBeNull();
      const expectedIndex = [...keys].sort().indexOf("common.add");
      expect(resDouble.code).toContain(`const msg = t(${expectedIndex});`);
      expect(resSingle.code).toContain(`const msg = t(${expectedIndex});`);
      expect(resWithArgs.code).toContain(`const msg = t(${expectedIndex}, { count: 1 });`);
    });

    it("ignores files in i18n directory with POSIX or Windows separators", () => {
      const plugin = i18nIndexPlugin();
      (plugin as any).configResolved({ command: "build", root: process.cwd() });
      const transform = (plugin as any).transform;

      const code = 'import { t } from "./i18n";\nconst msg = t("common.add");';
      const posixPath = path.resolve(process.cwd(), "src") + "/i18n/foo.ts";
      const windowsPath = path.resolve(process.cwd(), "src") + "\\i18n\\foo.ts";

      expect(transform.call({}, code, posixPath)).toBeNull();
      expect(transform.call({}, code, windowsPath)).toBeNull();
    });
  });
});
