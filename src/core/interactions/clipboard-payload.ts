import {
  AssetRef,
  ComponentElement,
  DesignDocument,
  DesignElement,
  DesignStyle,
  DesignToken,
  InstanceElement
} from "../dsl/types";
import { paintLayers } from "../dsl/image-fill";
import { findMasterComponent } from "./component-inventory";
import { heldMaster } from "./detached-masters";
import { isContainer, flattenElements } from "../geometry/tree-ops";


export const FISH_CLIPBOARD_TAG = "fish-clipboard@2";

const STYLE_ID_KEYS = ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"] as const;

/** Row spacing for parked masters; matches the gap `component-hoist` uses. */
const MASTER_ROW_GAP = 40;
const MASTER_ITEM_GAP = 12;

export interface FishClipboardPayload {
  tag: string;
  /**
   * Fresh per copy. Lets the paste site recognize its own file's copy and prefer
   * the in-memory clipboard, which keeps the component/instance links the
   * serialized fragment had to detach to be portable.
   */
  clipId: string;
  /** The copied subtrees, verbatim: an `instance` stays an `instance`. */
  elements: DesignElement[];

  masters: ComponentElement[];
  assets: AssetRef[];
  styles: DesignStyle[];
  /** `doc.tokens` entries the fragment's `tokenId` / `tokenBindings` name. */
  tokens?: DesignToken[];
}

/** A payload whose definitions have been reminted into the destination's id space. */
export interface ClipboardFragment {
  sources: DesignElement[];
  masters: ComponentElement[];
  assets: AssetRef[];
  styles: DesignStyle[];
  tokens?: DesignToken[];
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Every main component the copied subtrees reference, transitively.
 *
 * Transitive because a component may hold instances of other components — the
 * composite case, and the one that stops a one-hop implementation from shipping an
 * instance whose own master stayed behind. `heldMaster` covers a definition cut
 * or deleted earlier in the session: it is out of the document but still the
 * truth, and a copy taken in that window is the one moment the renderer draws
 * from it instead.
 *
 * `travelsInSet` is what keeps a copied component set from being taken apart. A
 * set's members are its own CONTENT, not references it points at: they travel
 * inside it, and `remintFragment` mints the whole subtree in one pass, so
 * listing one here as well would park a second node under that same id at the
 * page root. Its subtree is still walked, because an instance nested in a variant
 * is a real reference and has to come along.
 */
export function collectReferencedMasters(
  doc: DesignDocument,
  sources: readonly DesignElement[]
): ComponentElement[] {
  const found = new Map<string, ComponentElement>();

  const visitChildren = (el: DesignElement, insideSet: boolean): void => {
    if (!isContainer(el)) return;
    const inSet = insideSet || el.type === "componentSet";
    for (const child of el.children || []) visit(child, inSet);
  };

  const visit = (el: DesignElement, travelsInSet = false): void => {
    if (el.type === "component") {
      if (travelsInSet) {
        visitChildren(el, true);
        return;
      }
      // A master recurses only the first time it is seen, so `found` doubles as
      // the visited set: a hand-edited A-in-B-in-A cycle terminates here rather
      // than at the render-time `__masterChain` guard, which is much too late.
      if (found.has(el.id)) return;
      found.set(el.id, el as ComponentElement);
      visitChildren(el, false);
      return;
    }
    if (el.type === "instance") {
      const componentId = (el as InstanceElement).componentId;
      if (!found.has(componentId)) {
        const master = findMasterComponent(doc, componentId) ?? heldMaster(componentId);
        if (master) visit(master);
      }
      return;
    }
    visitChildren(el, travelsInSet);
  };

  for (const src of sources) visit(src);
  return [...found.values()];
}

/**
 * Image assets the fragment's fill stacks point at — the bytes that must travel
 * with a cross-file copy, since the destination cannot read the source file's.
 */
export function collectReferencedAssets(
  allAssets: readonly AssetRef[],
  elements: readonly DesignElement[]
): AssetRef[] {
  const byId = new Map(allAssets.map((a) => [a.id, a]));
  const found = new Map<string, AssetRef>();
  for (const el of flattenElements([...elements])) {
    for (const paint of paintLayers(el as { fills?: []; fill?: never })) {
      if (paint.type !== "image") continue;
      const ref = byId.get((paint as { assetId?: string }).assetId || "");
      if (ref) found.set(ref.id, ref);
    }
    const posterId = (el as { posterAssetId?: string }).posterAssetId;
    if (posterId) {
      const ref = byId.get(posterId);
      if (ref) found.set(ref.id, ref);
    }
  }
  return [...found.values()];
}

/**
 * The `doc.styles` entries the fragment is bound to.
 *
 * Only the referenced ones: a document may hold dozens, and a copy of one
 * component has no business dragging all of them across. Carrying a binding
 * preserves *editability* in the destination, not appearance — binding a style
 * also writes the concrete values inline (`bindFillStyle` and friends), so a
 * paste renders correctly whether or not the style arrives.
 */
function collectReferencedStyles(
  allStyles: readonly DesignStyle[] | undefined,
  elements: readonly DesignElement[]
): DesignStyle[] {
  if (!allStyles || allStyles.length === 0) return [];
  const wanted = new Set<string>();
  for (const el of flattenElements([...elements])) {
    const bound = el as unknown as Record<string, unknown>;
    for (const key of STYLE_ID_KEYS) {
      const id = bound[key];
      if (typeof id === "string" && id) wanted.add(id);
    }
    if (el.type === "instance" && Array.isArray((el as InstanceElement).overrides)) {
      for (const ov of (el as InstanceElement).overrides!) {
        if (
          (ov.property === "fillStyleId" ||
            ov.property === "strokeStyleId" ||
            ov.property === "textStyleId" ||
            ov.property === "effectStyleId") &&
          typeof ov.value === "string" &&
          ov.value
        ) {
          wanted.add(ov.value);
        }
      }
    }
  }
  return allStyles.filter((s) => wanted.has(s.id));
}

/**
 * The `doc.tokens` entries the fragment names, in either spelling a layer has:
 * a paint's or effect's `tokenId`, or a `tokenBindings` entry on the layer, its
 * text style or its effect.
 *
 * Without them a pasted token-bound fill would arrive with its materialised
 * colour and no binding — editable nowhere, which is the one thing a copy is
 * supposed to keep.
 */
function collectReferencedTokens(
  allTokens: readonly DesignToken[] | undefined,
  elements: readonly DesignElement[]
): DesignToken[] {
  if (!allTokens || allTokens.length === 0) return [];
  const wanted = new Set<string>();
  const want = (id: unknown): void => {
    if (typeof id === "string" && id) wanted.add(id);
  };
  for (const el of flattenElements([...elements])) {
    for (const paint of el.fills ?? []) want((paint as { tokenId?: string }).tokenId);
    for (const stroke of el.strokes ?? []) {
      want(stroke.tokenId);
      want(stroke.paint?.tokenId);
    }
    for (const effect of el.effects ?? []) {
      want((effect as { tokenId?: string }).tokenId);
      for (const id of Object.values(effect.tokenBindings ?? {})) want(id);
    }
    for (const id of Object.values(el.tokenBindings ?? {})) want(id);
    if (el.type === "text") {
      for (const id of Object.values(el.style?.tokenBindings ?? {})) want(id);
    }
  }
  return allTokens.filter((token) => wanted.has(token.id));
}

export function buildClipboardPayload(
  doc: DesignDocument,
  sources: readonly DesignElement[],
  clipId: string
): string {
  const masters = collectReferencedMasters(doc, sources);
  // Both arrays: a master is a separate top-level entry rather than something
  // folded into a flattened subtree, so collecting over the sources alone would
  // drop the image fills the master itself paints.
  const travelling = [...sources, ...masters];
  const payload: FishClipboardPayload = {
    tag: FISH_CLIPBOARD_TAG,
    clipId,
    elements: sources.map((s) => deepClone(s)),
    masters: masters.map((m) => deepClone(m)),
    assets: collectReferencedAssets(doc.assets || [], travelling),
    styles: collectReferencedStyles(doc.styles, travelling),
    tokens: collectReferencedTokens(doc.tokens, travelling)
  };
  return JSON.stringify(payload);
}

export function parseClipboardPayload(text: string): FishClipboardPayload | null {
  if (!text || !text.includes(FISH_CLIPBOARD_TAG)) {
    return null;
  }
  try {
    const data = JSON.parse(text) as FishClipboardPayload;
    if (!data || !Array.isArray(data.elements)) return null;
    if (data.tag === FISH_CLIPBOARD_TAG) return data;
  } catch {
    // foreign text, not ours
  }
  return null;
}
