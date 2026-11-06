import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { flattenDictionary } from "../src/i18n/flatten";
import { getLanguage, registerLanguage, setLanguage, t } from "../src/i18n";
import { analyzeSource } from "../scripts/i18n-keys";
import { encodeKeys, i18nIndexPlugin, scanI18n } from "../scripts/vite-plugin-i18n-index";

const { keys, values } = flattenDictionary(en as unknown as Record<string, unknown>);
const valueAt = new Map(keys.map((key, index) => [key, values[index]]));

const SOURCE_DIR = path.resolve(process.cwd(), "src");

/**
 * ONE scan, awaited once for the whole file.
 *
 * Reading `src` is the expensive half — ~700 file opens — so the three places
 * that need it share this one instead of each walking the tree. It is async
 * because `scanI18n` reads concurrently for exactly that reason.
 */
const scan = await scanI18n(SOURCE_DIR);

/** The runtime decoder's contract, reimplemented: a bug here is a value mismatch. */
function decode(encoded: string): Map<string, number> {
  const slots = new Map<string, number>();
  let previous = "";
  let slot = 0;
  for (const entry of encoded.split("\u0001")) {
    const head = entry.indexOf("|");
    const bar = entry.indexOf("|", head + 1);
    slot += parseInt(entry.slice(0, head), 36);
    previous = previous.slice(0, parseInt(entry.slice(head + 1, bar), 36)) + entry.slice(bar + 1);
    slots.set(previous, slot);
  }
  return slots;
}

afterEach(() => {
  setLanguage("en");
});

describe("the flattened i18n table", () => {
  it("resolves every authored key through the shipped key table", () => {
    // A front-coding or slot-delta bug shows up as the raw path here, not as a
    // blank label in the UI.
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
});

describe("every key a call site names is in the dictionary", () => {
  it("names one at every t() argument, including the ternary branches", () => {
    // The build plugin raises this for the files it rewrites; this catches the
    // drift before a build, in the one reader the plugin also uses. `checked`
    // is half the assertion: a lexer that quietly stopped matching reports no
    // missing keys either, and that is the failure this whole scan can cause.
    expect(scan.checked, "the scan must find the call sites, not an empty lex").toBeGreaterThan(1000);
    expect(scan.unknown).toEqual([]);
  });
});

describe("the t() reader", () => {
  // Each of these mis-lexes into "key referenced nowhere", which reads as a key
  // safe to prune — the one failure mode this whole change can introduce.
  const isKey = (key: string) => key.startsWith("a.");

  it("keeps reading past a self-closing JSX tag", () => {
    const code = 'const icon = <Icon size={13} />;\nconst label = t("a.b");';
    expect(analyzeSource(code, isKey).literals.map((literal) => literal.key)).toEqual(["a.b"]);
  });

  it("finds a call inside a template interpolation", () => {
    const code = "const line = `${t(`a.${x}`)}`;\nconst label = t('a.c');";
    expect(analyzeSource(code, isKey).literals.map((literal) => literal.key)).toEqual(["a.c"]);
  });

  it("ignores a call that is only a comment", () => {
    const code = '// t("a.dead")\nconst label = t("a.c");';
    expect(analyzeSource(code, isKey).literals.map((literal) => literal.key)).toEqual(["a.c"]);
  });

  it("reads a ternary condition's literal as a condition, not a key", () => {
    const code = 'const label = t(kind === "a.hint" ? "a.x" : "a.y");';
    const analysis = analyzeSource(code, isKey);
    expect(analysis.literals.map((literal) => literal.key)).toEqual(["a.hint", "a.x", "a.y"]);
    expect(analysis.calls[0].literals.map((literal) => literal.key)).toEqual(["a.x", "a.y"]);
    expect(analysis.unknown).toEqual([]);
  });
});

describe("the compiled table", () => {
  const { table, orphans } = scan;

  it("prunes the dictionary rather than restating it", () => {
    // Guards the optimisation itself: a scanner that quietly stops matching
    // would ship every key again and still pass every resolution above.
    expect(table.slots.size).toBeGreaterThan(900);
    expect(table.keys.size, "the runtime map is the exception, not the rule").toBeLessThan(keys.length / 2);
    expect(orphans, "an entry no call site can reach is dead weight in en.ts").toEqual([]);
  });

  it("keeps a runtime slot for every key a call site can only name at runtime", () => {
    const { keys: runtimeKeys } = table;
    for (const key of [
      "contextMenu.group",
      "component.overrideLabel.content",
      "pen.modeText",
      "tokens.categories.color"
    ]) {
      expect(runtimeKeys.get(key), `${key} is reached through a built path`).toBe(table.slots.get(key));
    }
    expect(runtimeKeys.has("common.add"), "a literal call site is inlined, not looked up").toBe(false);
  });

  it("encodes the runtime map back into the slots it was cut from", () => {
    const decoded = decode(encodeKeys(table.keys));
    expect(decoded.size).toBe(table.keys.size);
    for (const [key, slot] of decoded) {
      expect(table.keys.get(key)).toBe(slot);
      expect(table.values[slot], key).toBe(valueAt.get(key));
    }
  });
});

describe("i18nIndexPlugin transform", () => {
  function plugin() {
    const instance = i18nIndexPlugin();
    (instance as any).configResolved({ command: "build", root: process.cwd() });
    return (instance as any).transform;
  }

  const filePath = path.resolve(process.cwd(), "src/ui/test.tsx");

  // `transform` returns a promise now — it awaits the shipped table, the one scan
  // this build shares — so every case here reads its result.
  it("rewrites both double-quoted and single-quoted t() calls to slot indices", async () => {
    const transform = plugin();
    const codeDouble = 'import { t } from "./i18n";\nconst msg = t("common.add");';
    const codeSingle = "import { t } from './i18n';\nconst msg = t('common.add');";
    const codeWithArgs = "import { t } from './i18n';\nconst msg = t('common.add', { count: 1 });";

    const resDouble = await transform.call({}, codeDouble, filePath);
    const resSingle = await transform.call({}, codeSingle, filePath);
    const resWithArgs = await transform.call({}, codeWithArgs, filePath);

    expect(resDouble.code).toMatch(/const msg = t\(\d+\);/);
    expect(resSingle.code.match(/t\(\d+\)/)![0]).toBe(resDouble.code.match(/t\(\d+\)/)![0]);
    expect(resWithArgs.code).toMatch(/const msg = t\(\d+, \{ count: 1 \}\);/);
  });

  it("rewrites the branches of a ternary, and only the branches", async () => {
    const transform = plugin();
    const code =
      'import { t } from "./i18n";\nconst msg = t(kind === "hug" ? "stack.alignContentHug" : "stack.alignContentNoRoom");';
    const out = (await transform.call({}, code, filePath)).code;

    expect(out).toMatch(/t\(kind === "hug" \? \d+ : \d+\)/);
    const slots = out.match(/t\(kind === "hug" \? (\d+) : (\d+)\)/)!;
    const { table } = scan;
    expect(table.values[Number(slots[1])]).toBe(en.stack.alignContentHug);
    expect(table.values[Number(slots[2])]).toBe(en.stack.alignContentNoRoom);
  });

  it("leaves a built path and a key it cannot resolve alone", async () => {
    const transform = plugin();
    const template = 'import { t } from "./i18n";\nconst msg = t(`pen.mode${next}`);';
    const variable = 'import { t } from "./i18n";\nconst msg = t(LABEL[mode]);';

    expect(await transform.call({}, template, filePath)).toBeNull();
    expect(await transform.call({}, variable, filePath)).toBeNull();
  });

  it("does not mistake a quote inside a string for the start of a call", async () => {
    const transform = plugin();
    const code = `import { t } from './i18n';\nconst note = "don't";\nconst msg = t('common.add');`;
    expect((await transform.call({}, code, filePath)).code).toMatch(/t\(\d+\)/);
  });

  it("ignores files in i18n directory with POSIX or Windows separators", async () => {
    const transform = plugin();
    const code = 'import { t } from "./i18n";\nconst msg = t("common.add");';

    expect(await transform.call({}, code, path.resolve(process.cwd(), "src") + "/i18n/foo.ts")).toBeNull();
    expect(await transform.call({}, code, path.resolve(process.cwd(), "src") + "\\i18n\\foo.ts")).toBeNull();
  });
});
