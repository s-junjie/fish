/**
 * The document as the PAGE will hold it, before anything grades it.
 *
 * `check` used to grade the authored tree. An in-flow child of a stack stores the
 * coordinates it was written with and paints at the position the flow gives it, so
 * the two are not the same document: the load path has always laid the active page
 * out (`loadInitialDocument`), and every box-derived verdict — overlap, overflow,
 * "lies outside its parent" — answers a different question without that pass.
 *
 * The second answer here is the one the author never gets: a coordinate the flow
 * ignores. It is not a repair, because nothing was rewritten and the file is
 * readable; it is a statement about intent, and only the raw block still carries
 * the intent to compare against.
 */

import { relayoutDocumentTree } from "./layout/auto-layout";
import { instanceSizeResolver } from "./interactions/instance-size";
import { getActivePage, updateActivePageElements } from "./dsl/document-ops";
import { layoutOf } from "./dsl/layout-flat";
import type { CompileDiagnostic } from "./compile";
import type { DesignDocument, DesignElement } from "./dsl/types";

export interface LayoutFinding extends CompileDiagnostic {
  kind: "position-ignored";
}

export interface LaidOutDocument {
  document: DesignDocument;
  findings: LayoutFinding[];
}

const EPS = 0.5;
/** Each finding already stands for a whole container; past six this is a list, not a warning. */
const MAX_FINDINGS = 6;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const px = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

/** Only a coordinate the file LITERALLY states can be ignored. */
export type AuthoredPosition = { x: number | null; y: number | null };

/**
 * What the FILE wrote, by id. The layout pass overwrites the positions it places,
 * so after it runs this map is the only copy of the author's intent — which is
 * what `inspect` reports beside the box it actually got.
 */
export function authoredCoordinates(raw: unknown): Map<string, AuthoredPosition> {
  const out = new Map<string, AuthoredPosition>();
  const ambiguous = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const el = node as Record<string, unknown>;
    const id = typeof el.id === "string" ? el.id : "";
    if (id && ("x" in el || "y" in el)) {
      // Two elements with one id: which coordinate belongs to the one the layout
      // placed is unknowable, and a guess here becomes a warning about the wrong
      // node. Ambiguity is not evidence.
      if (out.has(id)) {
        ambiguous.add(id);
        out.delete(id);
      } else if (!ambiguous.has(id)) {
        out.set(id, { x: px(el.x), y: px(el.y) });
      }
    }
    const children = Array.isArray(el.children) ? el.children : [];
    for (const child of children) visit(child);
  };

  const doc = raw as Record<string, unknown> | null;
  const pages = Array.isArray(doc?.pages) ? (doc.pages as Array<Record<string, unknown>>) : [];
  const roots = pages.length > 0
    ? pages.flatMap((p) => (Array.isArray(p?.children) ? (p.children as unknown[]) : []))
    : Array.isArray(doc?.children)
      ? (doc.children as unknown[])
      : Array.isArray(doc?.elements)
        ? (doc.elements as unknown[])
        : [];
  for (const root of roots) visit(root);
  return out;
}

/**
 * What the flow did to coordinates the file stated.
 *
 * `position: "absolute"` is exempt by definition — that is the one spelling that
 * makes the coordinates mean something in a stack. A hidden child is exempt too:
 * nothing is placed, so nothing was ignored.
 *
 * One finding per CONTAINER, not per child. A stack imported from a design tool
 * carries a stale coordinate on most of its children (sixteen on one real page),
 * and sixteen sentences about one mistake is a report nobody finishes — the
 * parent is the thing that made the decision, so it is the thing named.
 */
function flowFindings(elements: DesignElement[], authored: Map<string, AuthoredPosition>): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  type Stray = { id: string; from: string; to: string };
  const stacks = new Map<string, { name: string; display: string; strays: Stray[] }>();

  const walk = (els: DesignElement[], parent: DesignElement | null) => {
    const layout = parent ? layoutOf(parent as never) : null;
    const inFlow = layout?.mode === "flex" || layout?.mode === "grid";
    for (const el of els) {
      const any = el as unknown as Record<string, unknown>;
      const stated = inFlow && any.position !== "absolute" && any.visible !== false
        ? authored.get(el.id)
        : undefined;
      if (stated) {
        // `(0, 0)` is the documented way to say "the flow decides", and the writer
        // emits it on every in-flow child: reporting zero would name the whole
        // document. Only a value that MEANT something is a value that was dropped.
        const wroteX = stated.x !== null && stated.x !== 0;
        const wroteY = stated.y !== null && stated.y !== 0;
        const placedX = num(any.x);
        const placedY = num(any.y);
        if ((wroteX && Math.abs(stated.x! - placedX) > EPS) || (wroteY && Math.abs(stated.y! - placedY) > EPS)) {
          const id = String(parent!.id);
          const entry = stacks.get(id) ?? {
            name: String(parent!.name || id),
            display: String(any.display ?? layout?.mode ?? "flex"),
            strays: []
          };
          entry.strays.push({
            id: el.id,
            from: `(${fmt(stated.x ?? placedX)}, ${fmt(stated.y ?? placedY)})`,
            to: `(${fmt(placedX)}, ${fmt(placedY)})`
          });
          stacks.set(id, entry);
        }
      }
      const children = (el as { children?: DesignElement[] }).children;
      if (children?.length) walk(children, el);
    }
  };

  walk(elements, null);

  let dropped = 0;
  for (const [id, stack] of stacks) {
    if (out.length >= MAX_FINDINGS) {
      dropped += 1;
      continue;
    }
    const named = stack.strays
      .slice(0, 3)
      .map((stray) => `${stray.id} ${stray.from} → ${stray.to}`)
      .join("; ");
    const more = stack.strays.length > 3 ? `; and ${stack.strays.length - 3} more child(ren)` : "";
    const subject =
      stack.strays.length === 1
        ? `ignores the x/y on "${stack.strays[0].id}"`
        : `ignores the x/y on ${stack.strays.length} in-flow children: ${named}${more}`;
    out.push({
      level: "warning",
      kind: "position-ignored",
      elementId: id,
      message:
        `"${stack.name}" (${stack.display}) ${subject}` +
        (stack.strays.length === 1 ? ` — ${named}` : "") +
        `. Add position "absolute" if the coordinates are the intent; otherwise delete them, because they read as intent and do nothing`
    });
  }
  if (dropped > 0) {
    out.push({
      level: "warning",
      kind: "position-ignored",
      message: `${dropped} more container(s) ignore their children's coordinates — the first ${MAX_FINDINGS} are named above`
    });
  }
  return out;
}

/**
 * The active page laid out as the loader lays it out, plus the coordinates that
 * pass threw away. Other pages keep what their author wrote, exactly as they do
 * on the canvas: only the active page is ever laid out.
 */
export function laidOutDocument(doc: DesignDocument, raw: unknown): LaidOutDocument {
  if (!doc.pages || doc.pages.length === 0) return { document: doc, findings: [] };
  const page = getActivePage(doc);
  const laid = relayoutDocumentTree(page.children ?? [], instanceSizeResolver(doc));
  return {
    document: updateActivePageElements(doc, laid),
    findings: flowFindings(laid, authoredCoordinates(raw))
  };
}

/** Every page laid out in sequence, with the ignored-coordinate findings keyed by page id. */
export function laidOutAllPages(
  doc: DesignDocument,
  raw: unknown
): LaidOutDocument & { findingsByPage: Map<string, LayoutFinding[]> } {
  if (!doc.pages || doc.pages.length === 0) {
    return { document: doc, findings: [], findingsByPage: new Map() };
  }
  const authored = authoredCoordinates(raw);
  const resolveInstanceSize = instanceSizeResolver(doc);
  const findingsByPage = new Map<string, LayoutFinding[]>();
  const allFindings: LayoutFinding[] = [];
  const pages = doc.pages.map((page) => {
    const laid = relayoutDocumentTree(page.children ?? [], resolveInstanceSize);
    const pageFindings = flowFindings(laid, authored);
    findingsByPage.set(page.id, pageFindings);
    allFindings.push(...pageFindings);
    return { ...page, children: laid };
  });
  return {
    document: { ...doc, pages },
    findings: allFindings,
    findingsByPage
  };
}
