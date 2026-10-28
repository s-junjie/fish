/**
 * ICU MessageFormat subset: `{arg}`, `{arg, plural, ...}`, `{arg, select, ...}`,
 * `{arg, selectordinal, ...}`, nested choices, exact `=N` plural cases and `#`.
 * Messages without a plural/select construct never reach this module; `t()`
 * keeps its cheaper single-regex interpolation for them.
 */
type Literal = { kind: 0; text: string };
type Argument = { kind: 1; name: string; raw: string };
type Pound = { kind: 2 };
type Choice = { kind: 3; name: string; type: "plural" | "selectordinal" | "select"; choices: Array<[string, Message]>; raw: string };
type Message = Array<Literal | Argument | Pound | Choice>;

const ICU_CONSTRUCT = /\{\s*[\w.-]+\s*,\s*(?:plural|selectordinal|select)\s*,/;

export function usesIcu(message: string): boolean {
  return ICU_CONSTRUCT.test(message);
}

function parse(message: string): Message {
  let at = 0;

  function read(pound: boolean): Message {
    const out: Message = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ kind: 0, text });
      text = "";
    };
    while (at < message.length) {
      const ch = message[at];
      if (ch === "}") break;
      if (ch === "#" && pound) {
        flush();
        out.push({ kind: 2 });
        at++;
        continue;
      }
      if (ch === "'" && message[at + 1] === "'") {
        text += "'";
        at += 2;
        continue;
      }
      if (ch !== "{") {
        text += ch;
        at++;
        continue;
      }
      const start = at;
      let cursor = at + 1;
      while (cursor < message.length && message[cursor] !== "," && message[cursor] !== "}") cursor++;
      const name = message.slice(at + 1, cursor).trim();
      if (!name) {
        text += "{";
        at++;
        continue;
      }
      if (message[cursor] !== ",") {
        if (message[cursor] !== "}") {
          text += "{";
          at++;
          continue;
        }
        flush();
        out.push({ kind: 1, name, raw: message.slice(start, cursor + 1) });
        at = cursor + 1;
        continue;
      }
      cursor++;
      while (cursor < message.length && /\s/.test(message[cursor])) cursor++;
      const typeStart = cursor;
      while (cursor < message.length && /\w/.test(message[cursor])) cursor++;
      const type = message.slice(typeStart, cursor);
      if (type !== "plural" && type !== "select" && type !== "selectordinal") {
        // `{n, number}` and friends keep the value, drop the format hint.
        while (cursor < message.length && message[cursor] !== "}") cursor++;
        flush();
        out.push({ kind: 1, name, raw: message.slice(start, cursor + 1) });
        at = cursor + 1;
        continue;
      }
      while (cursor < message.length && /\s/.test(message[cursor])) cursor++;
      if (message[cursor] !== ",") {
        text += "{";
        at++;
        continue;
      }
      cursor++;
      const choices: Array<[string, Message]> = [];
      for (;;) {
        while (cursor < message.length && /[\s,]/.test(message[cursor])) cursor++;
        if (cursor >= message.length || message[cursor] === "}") break;
        const keyStart = cursor;
        while (cursor < message.length && message[cursor] !== "{") cursor++;
        if (cursor >= message.length) break;
        const key = message.slice(keyStart, cursor).trim();
        cursor++;
        at = cursor;
        const branch = read(pound || type !== "select");
        cursor = at;
        while (cursor < message.length && /\s/.test(message[cursor])) cursor++;
        if (message[cursor] === "}") cursor++;
        choices.push([key, branch]);
      }
      flush();
      out.push({ kind: 3, name, type, choices, raw: message.slice(start, cursor + 1) });
      at = cursor + 1;
    }
    flush();
    return out;
  }

  return read(false);
}

const CACHE = new Map<string, Message>();
const RULES = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string, type: "plural" | "selectordinal"): Intl.PluralRules {
  const key = `${locale}:${type}`;
  let rules = RULES.get(key);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale, { type: type === "plural" ? "cardinal" : "ordinal" });
    } catch {
      rules = new Intl.PluralRules("en", { type: type === "plural" ? "cardinal" : "ordinal" });
    }
    RULES.set(key, rules);
  }
  return rules;
}

function render(message: Message, vars: Record<string, string | number>, locale: string, pound?: string): string {
  let out = "";
  for (const node of message) {
    if (node.kind === 0) {
      out += node.text;
    } else if (node.kind === 2) {
      out += pound ?? "#";
    } else if (node.kind === 1) {
      out += node.name in vars ? String(vars[node.name]) : node.raw;
    } else {
      const value = vars[node.name];
      if (value === undefined) {
        out += node.raw;
        continue;
      }
      let choice: [string, Message] | undefined;
      if (node.type === "select") {
        choice = node.choices.find(([key]) => key === String(value));
      } else {
        const count = Number(value);
        choice = node.choices.find(([key]) => key[0] === "=" && Number(key.slice(1)) === count);
        if (!choice) {
          const category = pluralRules(locale, node.type).select(count);
          choice = node.choices.find(([key]) => key === category);
        }
      }
      choice ??= node.choices.find(([key]) => key === "other");
      if (!choice) {
        out += node.raw;
        continue;
      }
      out += render(choice[1], vars, locale, node.type === "select" ? pound : String(value));
    }
  }
  return out;
}

export function formatMessage(
  message: string,
  vars: Record<string, string | number>,
  locale: string
): string {
  try {
    let parsed = CACHE.get(message);
    if (!parsed) {
      parsed = parse(message);
      CACHE.set(message, parsed);
    }
    return render(parsed, vars, locale);
  } catch {
    return message;
  }
}
