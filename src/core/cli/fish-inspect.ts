/**
 * `fish inspect <elementId> <doc>` — what the engine thinks one node IS.
 *
 * The other readers answer about a document: `check` grades it, `brief` lists what
 * is in it, `shot` photographs it. Editing by id needs the third question — which
 * box did this node actually get, which of its properties survived the layer it
 * came from, and what may be written on it — and until this existed the answer was
 * a 1.4 MB `compact`, a screenshot and an experiment.
 *
 * Everything below reads the SAME prepared document `check` grades
 * (`laidOutDocument`), so a box reported here and a box graded there cannot be two
 * different boxes. The one thing it adds is the file's own coordinates: after the
 * layout pass they are gone, and "you wrote x/y and the flow ignored it" is the
 * finding an author needs most.
 */

import { readDocument } from "./doc-source";
import { normalizeDesignDocument } from "../dsl/normalize";
import { syncDocumentBindings } from "../interactions/style-ops";
import { laidOutDocument, authoredCoordinates } from "../layout-report";
import { measureElement } from "../measure";
import { findElementById, flattenElements } from "../geometry/tree-ops";
import { findMasterComponent } from "../interactions/component-inventory";
import { overridableFor, overrideProblem } from "../interactions/override-audit";
import { resolveInstanceSelection } from "../interactions/instance-resolve";
import { layoutOf } from "../dsl/layout-flat";
import { resolvePadding } from "../compile";
import { resolveAxis } from "../geometry/resolve-axis";
import { textSpec } from "../layout/text-sizing";
import { textFontStatus } from "../fonts/font-status";
import { colorTokenColor } from "../interactions/token-ops";
import { getActivePage } from "../dsl/document-ops";
import type { ComponentElement, ContainerElement, DesignDocument, DesignElement, Paint, TextStyle } from "../dsl/types";

export interface InspectedSlot {
  id: string;
  type: string;
  value: string;
  properties: string[];
}

export interface Inspection {
  id: string;
  name: string;
  type: string;
  page: string;
  box: {
    local: { x: number; y: number; width: number; height: number };
    canvas: { x: number; y: number; width: number; height: number };
    rendered: boolean;
    sizing: { width: string; height: string };
  };
  flow?: {
    parentId: string;
    parentName: string;
    mode: string;
    direction?: string;
    align?: string;
    gap?: number;
    absolute: boolean;
    /** What the file said, when the flow is what placed the node. */
    ignored?: { x: number | null; y: number | null };
  };
  text?: {
    content: string;
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
    family: string;
    font?: { family: string; status: string };
  };
  layout?: {
    mode: string;
    direction?: string;
    gap?: number;
    justify?: string;
    align?: string;
    padding: [number, number, number, number];
  };
  paints: string[];
  parents: { id: string; type: string; label: string }[];
  instance?: {
    masterId: string;
    masterName: string;
    slots: InspectedSlot[];
    slotsTotal: number;
    overrides: { total: number; applies: number; problems: string[] };
  };
  derived?: { masterId: string; instanceId: string };
}

const rect = (r: { x: number; y: number; width: number; height: number }) => ({
  x: round(r.x),
  y: round(r.y),
  width: round(r.width),
  height: round(r.height)
});
const round = (n: number) => Math.round(n * 100) / 100;

function tokenName(doc: DesignDocument, tokenId: unknown): string {
  if (typeof tokenId !== "string" || !tokenId) return "";
  const token = (doc.tokens ?? []).find((t) => t.id === tokenId);
  if (!token) return ` (token ${tokenId} is missing)`;
  const value = token.type === "color" ? colorTokenColor(token as never, doc.activeTheme, doc.tokens) : "";
  return ` ← ${token.name}${value ? ` (${value})` : ""}`;
}

/** One line per paint, naming where its value came from. */
function paintsOf(doc: DesignDocument, el: DesignElement): string[] {
  const out: string[] = [];
  const rows = (list: Paint[] | undefined, role: string) => {
    for (const paint of list ?? []) {
      if (paint.enabled === false) continue;
      out.push(`${role.padEnd(6)} ${describePaint(doc, paint)}`);
    }
  };
  rows(el.fills as Paint[] | undefined, "fill");
  rows(((el as { strokes?: { paint?: Paint }[] }).strokes ?? []).map((s) => s.paint).filter(Boolean) as Paint[], "stroke");
  for (const effect of (el.effects ?? []) as { type?: string; enabled?: boolean }[]) {
    if (effect?.enabled === false) continue;
    out.push(`effect  ${String(effect.type ?? "?")}`);
  }
  return out;
}

function describePaint(doc: DesignDocument, paint: Paint): string {
  const any = paint as unknown as Record<string, unknown>;
  if (paint.type === "solid") {
    return `${String(any.color ?? "")}${tokenName(doc, any.tokenId)}`;
  }
  if (paint.type === "image") {
    const fit = any.fit ? `, ${String(any.fit)}` : "";
    return `image (asset ${String(any.assetId ?? "?")}${fit})`;
  }
  const stops = Array.isArray(any.stops) ? (any.stops as unknown[]).length : 0;
  return `${paint.type} (${stops} stop${stops === 1 ? "" : "s"})${tokenName(doc, any.tokenId)}`;
}

function slotValue(el: DesignElement): string {
  if (el.type === "text") {
    const content = String((el as { content?: string }).content ?? "").replace(/\s+/g, " ").trim();
    return content.length > 40 ? `${JSON.stringify(content.slice(0, 40))}…` : JSON.stringify(content);
  }
  const fills = (el.fills ?? []) as Paint[];
  if (fills.length > 0) return `${fills.length} fill(s)`;
  return "—";
}

function labelOf(el: DesignElement): string {
  const any = el as unknown as Record<string, unknown>;
  const bits: string[] = [el.type];
  if (any.width !== undefined && any.height !== undefined) {
    bits.push(`${round(Number(any.width))}×${round(Number(any.height))}`);
  }
  const layout = layoutOf(el as never);
  if (layout) bits.push(`display ${layout.mode}${layout.direction ? ` ${layout.direction}` : ""}`);
  return bits.join(" · ");
}

function chainOf(doc: DesignDocument, id: string): { chain: DesignElement[]; element: DesignElement } | null {
  const walk = (els: DesignElement[], trail: DesignElement[]): { chain: DesignElement[]; element: DesignElement } | null => {
    for (const el of els) {
      if (el.id === id) return { chain: [...trail, el], element: el };
      const children = (el as { children?: DesignElement[] }).children;
      if (children?.length) {
        const found = walk(children, [...trail, el]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(getActivePage(doc).children ?? [], []);
}

export function inspectElement(
  doc: DesignDocument,
  id: string,
  opts: { authored?: Map<string, { x: number | null; y: number | null }>; allSlots?: boolean } = {}
): Inspection | null {
  const measured = measureElement(doc, id);
  const located = chainOf(doc, id);
  // A resolved clone has no place in the stored tree: it is what the canvas shows
  // when you click inside an instance, so `inspect` has to answer for it too —
  // through the same function the editor resolves that click with.
  const selection = located ? null : resolveInstanceSelection(doc, id);
  if (!measured || (!located && !selection)) return null;

  const chain = located?.chain ?? [];
  const element = located?.element ?? selection!.node;
  const parent = (chain.length > 1 ? chain[chain.length - 2] : null) as ContainerElement | null;
  const parentLayout = parent ? layoutOf(parent as never) : null;
  const inFlow = Boolean(parentLayout) && (element as { position?: string }).position !== "absolute";
  const authored = opts.authored?.get(id);
  // The pair is reported as the author wrote it, and only when the flow did not
  // reproduce it: half a pixel of cross-axis centring is not a mistake, but a
  // coordinate that MOVED is, and then both halves of what they wrote are the
  // useful thing to see.
  const moved = (value: number | null, placed: number) => value !== null && Math.abs(value - placed) > 0.5;
  const ignored =
    authored && (moved(authored.x, measured.local.x) || moved(authored.y, measured.local.y))
      ? { x: authored.x, y: authored.y }
      : null;

  const inspection: Inspection = {
    id: element.id,
    name: String((element as { name?: string }).name ?? ""),
    type: element.type,
    page: getActivePage(doc).name ?? "",
    box: {
      local: rect(measured.local),
      canvas: rect(measured),
      rendered: measured.rendered,
      sizing: {
        width: resolveAxis(element, parent, "width"),
        height: resolveAxis(element, parent, "height")
      }
    },
    paints: paintsOf(doc, element),
    parents: chain.slice(0, -1).map((el) => ({ id: el.id, type: el.type, label: labelOf(el) }))
  };

  if (parent && parentLayout) {
    inspection.flow = {
      parentId: parent.id,
      parentName: String((parent as { name?: string }).name ?? ""),
      mode: parentLayout.mode,
      direction: parentLayout.direction,
      align: parentLayout.align,
      gap: parentLayout.gap,
      absolute: !inFlow,
      ...(inFlow && ignored ? { ignored } : {})
    };
  }

  if (element.type === "text") {
    const text = element as DesignElement & { content?: string; style?: TextStyle; spans?: unknown };
    const spec = textSpec((text.style ?? {}) as TextStyle, text.spans as never);
    const status = textFontStatus(element);
    inspection.text = {
      content: String(text.content ?? ""),
      fontSize: spec.fontSize,
      lineHeight: spec.lineHeight,
      letterSpacing: spec.letterSpacing,
      family: spec.fontFamily,
      ...(status ? { font: { family: status.family, status: String(status.status) } } : {})
    };
  }

  const own = layoutOf(element as never);
  if (own) {
    inspection.layout = {
      mode: own.mode,
      direction: own.direction,
      gap: own.gap,
      justify: own.justify,
      align: own.align,
      padding: resolvePadding(own.padding)
    };
  }

  if (selection) {
    inspection.derived = { masterId: selection.masterNodeId, instanceId: selection.instanceId };
    inspection.parents = [
      {
        id: selection.instanceId,
        type: "instance",
        label: `instance · of "${String((selection.master as { name?: string }).name ?? selection.master.id)}"`
      }
    ];
  }

  if (element.type === "instance") {
    const instance = element as DesignElement & { componentId: string; overrides?: { targetId: string; property: string }[] };
    const master = findMasterComponent(doc, instance.componentId) as ComponentElement | null;
    if (master) {
      const slots = flattenElements(master.children ?? []).map<InspectedSlot>((child) => ({
        id: child.id,
        type: child.type,
        value: slotValue(child),
        properties: overridableFor(child)
      }));
      inspection.instance = {
        masterId: master.id,
        masterName: String(master.name ?? master.id),
        slots: opts.allSlots ? slots : slots.slice(0, 4),
        slotsTotal: slots.length,
        overrides: {
          total: (instance.overrides ?? []).length,
          applies: (instance.overrides ?? []).filter((o) => overrideProblem(master, o, doc) === null).length,
          problems: (instance.overrides ?? [])
            .map((o) => overrideProblem(master, o, doc))
            .filter((p): p is string => p !== null)
        }
      };
    }
  }

  return inspection;
}

/** Six names and a count: the full list is `--all`'s job. */
function propertySummary(properties: readonly string[]): string {
  if (properties.length <= 6) return properties.join(", ");
  return `${properties.slice(0, 6).join(", ")} +${properties.length - 6} more`;
}

const pad = (label: string) => `  ${label.padEnd(10)}`;

function boxLine(r: { x: number; y: number; width: number; height: number }): string {
  return `${round(r.width)}×${round(r.height)} at (${round(r.x)}, ${round(r.y)})`;
}

export function formatInspection(found: Inspection): string {
  const lines: string[] = [];
  lines.push(`${found.id}${found.name && found.name !== found.id ? ` "${found.name}"` : ""} · ${found.type} · page "${found.page}"`);
  lines.push(`${pad("box")}${boxLine(found.box.local)}   [local]`);
  lines.push(`${pad("canvas")}${boxLine(found.box.canvas)}${found.box.rendered ? "" : "   (not painted right now)"}`);
  lines.push(`${pad("sizing")}width ${found.box.sizing.width} · height ${found.box.sizing.height}`);

  if (!found.flow && found.parents.length > 0) {
    const parent = found.parents[found.parents.length - 1];
    lines.push(`${pad("placed")}plain frame "${parent.id}" — x/y honoured`);
  }

  if (found.flow) {
    const bits = [`${found.flow.mode}${found.flow.direction ? ` ${found.flow.direction}` : ""}`];
    if (found.flow.align) bits.push(`align-items ${found.flow.align}`);
    if (found.flow.gap) bits.push(`gap ${found.flow.gap}`);
    const how = found.flow.absolute ? "absolute" : `in flow of "${found.flow.parentName || found.flow.parentId}"`;
    const ignored = found.flow.ignored
      ? `   ← x/y (${found.flow.ignored.x ?? "-"}, ${found.flow.ignored.y ?? "-"}) in the file ignored`
      : "";
    lines.push(`${pad("placed")}${how} · ${bits.join(" · ")}${ignored}`);
  }

  if (found.text) {
    const t = found.text;
    const font = t.font ? ` · ${t.font.family} (${t.font.status})` : "";
    lines.push(
      `${pad("text")}${JSON.stringify(t.content)} · ${round(t.fontSize)}px/${round(t.lineHeight)}px · tracking ${round(t.letterSpacing)}${font}`
    );
  }

  if (found.layout) {
    const l = found.layout;
    const bits = [`${l.mode}${l.direction ? ` ${l.direction}` : ""}`];
    if (l.justify) bits.push(`justify ${l.justify}`);
    if (l.align) bits.push(`align ${l.align}`);
    if (l.gap) bits.push(`gap ${l.gap}`);
    bits.push(`padding ${l.padding.join("/")}`);
    lines.push(`${pad("container")}${bits.join(" · ")}`);
  }

  if (found.paints.length === 0) lines.push(`${pad("paint")}${found.instance ? "none of its own — inherited from the master" : "none"}`);
  else found.paints.forEach((paint, i) => lines.push(`${pad(i === 0 ? "paint" : "")}${paint}`));

  lines.push(`${pad("parent")}${found.parents.map((p) => `${p.id} (${p.label})`).join(" > ") || "page"}`);

  if (found.derived) {
    lines.push(`${pad("derived")}clone of "${found.derived.masterId}" via instance "${found.derived.instanceId}" — write it as an override on that instance`);
  }

  if (found.instance) {
    const inst = found.instance;
    lines.push(`${pad("instance")}of "${inst.masterName}" (${inst.masterId})`);
    lines.push(
      `${pad("overrides")}${inst.overrides.total} in file · ${inst.overrides.applies} apply` +
        (inst.overrides.problems.length > 0 ? ` · ${inst.overrides.problems.length} cannot: ${inst.overrides.problems[0]}` : "")
    );
    const shown = found.instance.slots;
    lines.push(
      `${pad("slots")}${inst.slotsTotal} in master${shown.length < inst.slotsTotal ? ` — first ${shown.length}, --all to list every one` : ""}`
    );
    for (const slot of shown) {
      lines.push(`    ${slot.id.padEnd(18)} ${slot.type.padEnd(9)} ${slot.value.padEnd(14)} ${propertySummary(slot.properties)}`);
    }
  }

  return lines.join("\n");
}

export function inspect(file: string, elementId: string, opts: { json: boolean; allSlots?: boolean }): number {
  const read = readDocument(file);
  if ("error" in read) {
    console.error(read.error);
    return read.code;
  }
  const { src, value: raw } = read;

  const { document } = normalizeDesignDocument(raw);
  const prepared = laidOutDocument(syncDocumentBindings(document), raw).document;
  const found = inspectElement(prepared, elementId, {
    authored: authoredCoordinates(raw),
    allSlots: opts.allSlots
  });

  if (!found) {
    console.error(`${src.file}: no element with id "${elementId}"`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify({ file: src.file, element: found }, null, 2));
    return 0;
  }
  console.log(`${src.file}`);
  console.log(formatInspection(found));
  return 0;
}
