import { afterEach, describe, expect, it } from "vitest";
import { formatMessage } from "../src/i18n/format";
import { registerLanguage, setLanguage, t } from "../src/i18n";

afterEach(() => {
  setLanguage("en");
});

describe("ICU messages", () => {
  it("formats arguments and keeps an absent one legible", () => {
    expect(formatMessage("Imported {n} elements from {name}", { n: 4, name: "card" }, "en")).toBe(
      "Imported 4 elements from card"
    );
    expect(formatMessage("Imported {n} elements from {name}", { n: 4 }, "en")).toBe(
      "Imported 4 elements from {name}"
    );
  });

  it("picks the English plural category", () => {
    const message = "{n, plural, =0 {No files} one {# file} other {# files}}";
    expect(formatMessage(message, { n: 0 }, "en")).toBe("No files");
    expect(formatMessage(message, { n: 1 }, "en")).toBe("1 file");
    expect(formatMessage(message, { n: 2 }, "en")).toBe("2 files");
  });

  it("uses ordinal categories", () => {
    const message = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    expect(formatMessage(message, { n: 1 }, "en")).toBe("1st");
    expect(formatMessage(message, { n: 2 }, "en")).toBe("2nd");
    expect(formatMessage(message, { n: 3 }, "en")).toBe("3rd");
    expect(formatMessage(message, { n: 4 }, "en")).toBe("4th");
    expect(formatMessage(message, { n: 11 }, "en")).toBe("11th");
    expect(formatMessage(message, { n: 21 }, "en")).toBe("21st");
    expect(formatMessage(message, { n: 22 }, "en")).toBe("22nd");
    expect(formatMessage(message, { n: 23 }, "en")).toBe("23rd");
  });

  it("selects by gender and nests inside a plural", () => {
    const message =
      "{who, select, female {She} male {He} other {They}} left";
    expect(formatMessage(message, { who: "female" }, "en")).toBe("She left");
    expect(formatMessage(message, { who: "male" }, "en")).toBe("He left");
    expect(formatMessage(message, { who: "robot" }, "en")).toBe("They left");

    const nested =
      "{n, plural, one {{who, select, female {# item of hers} other {# item of theirs}}} other {{who, select, female {# items of hers} other {# items of theirs}}}}";
    expect(formatMessage(nested, { n: 1, who: "female" }, "en")).toBe("1 item of hers");
    expect(formatMessage(nested, { n: 3, who: "robot" }, "en")).toBe("3 items of theirs");
  });

  it("follows the locale's plural rules", () => {
    const message = "{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}";
    expect(formatMessage(message, { n: 1 }, "ru")).toBe("1 файл");
    expect(formatMessage(message, { n: 2 }, "ru")).toBe("2 файла");
    expect(formatMessage(message, { n: 5 }, "ru")).toBe("5 файлов");
    expect(formatMessage(message, { n: 1.5 }, "ru")).toBe("1.5 файла");
  });

  it("falls back to other when a category is absent", () => {
    expect(formatMessage("{n, plural, one {one} other {other}}", { n: 2 }, "ru")).toBe("other");
  });

  it("runs authored messages through the table", () => {
    expect(t("tokens.uses", { n: 1 })).toBe("1 use");
    expect(t("tokens.uses", { n: 2 })).toBe("2 uses");
    expect(t("documentJson.importSummary", { pages: 1, elements: 3 })).toBe("1 page · 3 elements");
    expect(t("comments.replies", { n: 0 })).toBe("0 replies");
  });

  it("applies a locale's own wording and English for what it omits", () => {
    registerLanguage("test-icu", {
      tokens: { uses: "{n, plural, one {# Nutzung} other {# Nutzungen}}" }
    });
    setLanguage("test-icu");
    expect(t("tokens.uses", { n: 2 })).toBe("2 Nutzungen");
    expect(t("comments.replies", { n: 1 })).toBe("1 reply");
  });
});
