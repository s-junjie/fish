import fs from "node:fs";
import path from "node:path";
import { writtenKeyOf, INPUT_ONLY_KEYS } from "../dsl/written-keys";

type Property = Record<string, unknown>;
type SchemaNode = Record<string, unknown> & {
  description?: string;
  type?: string;
  enum?: unknown[];
  pattern?: string;
  required?: string[];
  properties?: Record<string, Property>;
  items?: SchemaNode | SchemaNode[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  allOf?: SchemaNode[];
};
type JsonSchema = SchemaNode & {
  definitions?: Record<string, SchemaNode>;
};
type Match = { definition: string; key: string; property: Property };
type CatalogEntry = {
  name: string;
  description?: string;
  enum?: unknown[];
  pattern?: string;
  keys: string[];
};
export type SchemaOpts = { json: boolean; list?: boolean; find?: string };

const FILE = "fish.schema.json";

// The bundle sits beside tools/fish.schema.json; in a checkout this file runs
// from src/core/cli and the contract lives at src/core/dsl.
function schemaPath(script = process.argv[1]): string | null {
  const dir = script ? path.dirname(script) : "";
  const candidates = [
    ...(script ? [path.join(dir, FILE), path.join(dir, "..", "dsl", FILE)] : []),
    path.resolve("tools", FILE),
    path.resolve("src", "core", "dsl", FILE)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function pushMatch(out: Match[], seen: Set<string>, definition: string, key: string, property: Property): void {
  const sig = `${definition}\0${key}\0${JSON.stringify(property)}`;
  if (seen.has(sig)) return;
  seen.add(sig);
  out.push({ definition, key, property });
}

function collectNode(owner: string, node: SchemaNode, out: Match[], seen: Set<string>): void {
  if (node.properties && typeof node.properties === "object") {
    for (const [key, raw] of Object.entries(node.properties)) {
      if (!raw || typeof raw !== "object") continue;
      const property = raw as SchemaNode;
      pushMatch(out, seen, owner, key, property);
      collectNode(`${owner}.${key}`, property, out, seen);
      if (property.items) {
        const items = Array.isArray(property.items) ? property.items : [property.items];
        for (const item of items) {
          if (item && typeof item === "object") collectNode(`${owner}.${key}[]`, item, out, seen);
        }
      }
    }
  }
  // Traverse schema combinators (e.g. DesignToken oneOf) without descending into
  // conditional `if`/`then` validation guards (e.g. Tear.allOf).
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch && typeof branch === "object") collectNode(owner, branch as SchemaNode, out, seen);
    }
  }
}

function propertiesOf(schema: JsonSchema): Match[] {
  const out: Match[] = [];
  const seen = new Set<string>();
  collectNode("DesignDocument", schema, out, seen);
  for (const [definition, body] of Object.entries(schema.definitions ?? {})) {
    if (body && typeof body === "object") collectNode(definition, body, out, seen);
  }
  return out;
}

function definitionEntries(schema: JsonSchema): Array<[string, SchemaNode]> {
  return [
    ["DesignDocument", schema],
    ...Object.entries(schema.definitions ?? {}).filter((entry): entry is [string, SchemaNode] =>
      Boolean(entry[1] && typeof entry[1] === "object")
    )
  ];
}

function ownsDefinition(owner: string, defName: string): boolean {
  return owner === defName || owner.startsWith(`${defName}.`);
}

function catalogKeyName(owner: string, defName: string, key: string): string {
  if (owner === defName) return key;
  const sub = owner.slice(defName.length + 1);
  return `${sub}.${key}`;
}

function buildCatalog(schema: JsonSchema, all: Match[]): CatalogEntry[] {
  return definitionEntries(schema).map(([name, node]) => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const entry of all) {
      if (!ownsDefinition(entry.definition, name)) continue;
      const label = catalogKeyName(entry.definition, name, entry.key);
      if (seen.has(label)) continue;
      seen.add(label);
      keys.push(label);
    }
    return {
      name,
      ...(typeof node.description === "string" ? { description: node.description } : {}),
      ...(Array.isArray(node.enum) ? { enum: node.enum } : {}),
      ...(typeof node.pattern === "string" ? { pattern: node.pattern } : {}),
      keys
    };
  });
}

function typeSummary(property: Property): string {
  if (Array.isArray(property.enum)) return `enum(${property.enum.join(" | ")})`;
  if (typeof property.$ref === "string") return property.$ref.replace("#/definitions/", "");
  if (typeof property.type === "string") {
    const items = property.items as Property | undefined;
    if (property.type === "array" && items) return `${typeSummary(items)}[]`;
    return property.type;
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = property[key];
    if (Array.isArray(branches)) {
      return branches.map((b) => (b && typeof b === "object" ? typeSummary(b as Property) : "any")).join(" | ");
    }
  }
  return "any";
}

function runList(schema: JsonSchema, all: Match[], json: boolean): number {
  const definitions = buildCatalog(schema, all);
  if (json) {
    console.log(JSON.stringify({ mode: "list", definitions }));
    return 0;
  }
  console.log(`${FILE} — ${definitions.length} definitions (query one with ./tools/fish schema <Def|key> or --find <word>)\n`);
  for (const entry of definitions) {
    if (entry.keys.length > 0) {
      console.log(`${entry.name}: ${entry.keys.join(", ")}`);
    } else if (entry.enum) {
      console.log(`${entry.name} [enum]: ${entry.enum.join(", ")}`);
    } else if (entry.pattern) {
      console.log(`${entry.name} [pattern]: ${entry.pattern}`);
    } else {
      console.log(entry.name);
    }
  }
  return 0;
}

function findMatches(schema: JsonSchema, all: Match[], query: string) {
  const q = query.trim().toLowerCase();
  const defs = definitionEntries(schema).filter(([name, node]) => {
    if (name.toLowerCase().includes(q)) return true;
    if (typeof node.description === "string" && node.description.toLowerCase().includes(q)) return true;
    if (Array.isArray(node.enum) && node.enum.some((v) => String(v).toLowerCase().includes(q))) return true;
    return false;
  });
  const keyHits: Match[] = [];
  const textHits: Match[] = [];
  for (const entry of all) {
    if (entry.key.toLowerCase().includes(q) || entry.definition.toLowerCase().includes(q)) {
      keyHits.push(entry);
      continue;
    }
    const text = JSON.stringify(entry.property).toLowerCase();
    if (text.includes(q)) textHits.push(entry);
  }
  return { defs, matches: [...keyHits, ...textHits] };
}

function runFind(schema: JsonSchema, all: Match[], query: string, json: boolean): number {
  const trimmed = query.trim();
  if (!trimmed) {
    console.error("--find needs a non-empty search word");
    return 2;
  }
  const { defs, matches } = findMatches(schema, all, trimmed);
  const defItems = defs.map(([name, node]) => ({
    definition: name,
    ...(typeof node.description === "string" ? { description: node.description } : {}),
    ...(Array.isArray(node.enum) ? { enum: node.enum } : {})
  }));
  if (json) {
    console.log(JSON.stringify({ find: trimmed, definitions: defItems, matches }));
    return defItems.length > 0 || matches.length > 0 ? 0 : 1;
  }
  if (defItems.length === 0 && matches.length === 0) {
    console.error(`no matches for "${trimmed}" in ${FILE}`);
    return 1;
  }
  console.log(`"${trimmed}" — ${defItems.length} definition(s), ${matches.length} field(s) in ${FILE}\n`);
  for (const d of defItems) {
    const tail = d.enum ? `[enum: ${d.enum.join(", ")}]` : d.description ?? "";
    console.log(`${d.definition} (definition)${tail ? ` — ${tail}` : ""}`);
  }
  const limit = 40;
  for (const entry of matches.slice(0, limit)) {
    const desc = typeof entry.property.description === "string" ? ` — ${entry.property.description}` : "";
    console.log(`${entry.definition}.${entry.key}: ${typeSummary(entry.property)}${desc}`);
  }
  if (matches.length > limit) {
    console.log(`\n... ${matches.length - limit} more match(es); refine --find or query a key directly.`);
  }
  return 0;
}

function runDefinition(defName: string, node: SchemaNode, all: Match[], key: string, json: boolean): number {
  const matches = all.filter((entry) => ownsDefinition(entry.definition, defName));
  if (json) {
    console.log(
      JSON.stringify({
        key,
        definition: defName,
        ...(typeof node.description === "string" ? { description: node.description } : {}),
        ...(Array.isArray(node.enum) ? { enum: node.enum } : {}),
        ...(typeof node.pattern === "string" ? { pattern: node.pattern } : {}),
        ...(Array.isArray(node.required) ? { required: node.required } : {}),
        matches
      })
    );
    return 0;
  }
  console.log(`${defName} — definition in ${FILE}\n`);
  if (typeof node.description === "string") console.log(`  description: ${node.description}`);
  if (Array.isArray(node.enum)) console.log(`  enum: ${JSON.stringify(node.enum)}`);
  if (typeof node.pattern === "string") console.log(`  pattern: ${node.pattern}`);
  if (Array.isArray(node.required)) console.log(`  required: ${JSON.stringify(node.required)}`);
  if (matches.length > 0) {
    console.log("");
    for (const entry of matches) {
      const prefix = entry.definition === defName ? entry.key : catalogKeyName(entry.definition, defName, entry.key);
      const desc = typeof entry.property.description === "string" ? ` — ${entry.property.description}` : "";
      console.log(`  ${prefix}: ${typeSummary(entry.property)}${desc}`);
    }
  }
  return 0;
}

function dedupMatches(entries: Match[]): Match[] {
  const out: Match[] = [];
  const seen = new Set<string>();
  for (const entry of entries) pushMatch(out, seen, entry.definition, entry.key, entry.property);
  return out;
}

export function schemaCommand(key: string, opts: SchemaOpts): number {
  const file = schemaPath();
  if (!file) {
    console.error(`cannot find ${FILE} beside tools/fish — re-install the kit`);
    return 1;
  }

  const schema = JSON.parse(fs.readFileSync(file, "utf8")) as JsonSchema;
  const all = propertiesOf(schema);

  if (opts.list || (!key && !opts.find)) return runList(schema, all, opts.json);
  if (opts.find !== undefined) return runFind(schema, all, opts.find, opts.json);

  const defs = definitionEntries(schema);
  const direct = all.filter((entry) => entry.key === key);
  const elementPublished = writtenKeyOf(key);
  const elementAlias = elementPublished !== null && elementPublished !== key;
  const absorbed = !elementPublished && INPUT_ONLY_KEYS.has(key);

  const exactDef = defs.find(([name]) => name === key);
  const fallbackDef =
    !exactDef && direct.length === 0 && !elementAlias && !absorbed
      ? defs.find(([name]) => name.toLowerCase() === key.toLowerCase())
      : undefined;
  const matchedDef = exactDef ?? fallbackDef;
  if (matchedDef) return runDefinition(matchedDef[0], matchedDef[1], all, key, opts.json);

  const aliasTargets = elementAlias ? all.filter((entry) => entry.key === elementPublished) : [];
  const found = dedupMatches([...direct, ...aliasTargets]);
  // Preserve `published: key` for non-element keys (e.g. `tokens`, `transition`),
  // while keeping `elementPublished` for element keys and element-level aliases.
  const published = elementPublished ?? (direct.length > 0 && !absorbed ? key : null);

  if (opts.json) {
    console.log(JSON.stringify({ key, published, alias: elementAlias, absorbed, matches: found }));
    return found.length > 0 || absorbed ? 0 : 1;
  }

  if (elementAlias) {
    const directDefs = [...new Set(direct.map((entry) => entry.definition))];
    const nestedNote = directDefs.length > 0 ? ` (nested types like ${directDefs.join(", ")} still use "${key}")` : "";
    console.log(
      `"${key}" is an input-only element alias. Write "${elementPublished}" on elements${nestedNote}.\n`
    );
  } else if (absorbed) {
    const directDefs = [...new Set(direct.map((entry) => entry.definition))];
    console.log(
      directDefs.length > 0
        ? `"${key}" is folded on DesignElement, but is a published key on ${directDefs.join(", ")}.\n`
        : `"${key}" is an input-only alias: normalize folds it into another field, so there is no published spelling to write.\n`
    );
  }

  if (found.length === 0) {
    if (absorbed) return 0;
    const near = all
      .map((entry) => entry.key)
      .filter((name) => name.toLowerCase().includes(key.toLowerCase()))
      .filter((name, index, names) => names.indexOf(name) === index)
      .slice(0, 12);
    const search = findMatches(schema, all, key);
    const searchCount = search.defs.length + search.matches.length;
    const hint = searchCount > 0 ? `\n  search: ./tools/fish schema --find ${key} (${searchCount} match${searchCount === 1 ? "" : "es"})` : "";
    console.error(`no key "${key}" in ${FILE}${near.length > 0 ? `\n  close: ${near.join(", ")}` : ""}${hint}`);
    return 1;
  }

  const label = published && elementAlias && direct.length === 0 ? published : key;
  console.log(`${label} — ${found.length} match${found.length === 1 ? "" : "es"} in ${FILE}\n`);
  for (const { definition, key: name, property } of found) {
    console.log(`${definition}.${name}`);
    for (const [field, value] of Object.entries(property)) {
      console.log(`  ${field}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
    console.log("");
  }
  return 0;
}
