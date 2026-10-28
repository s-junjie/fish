import {
  ComponentElement,
  ContainerElement,
  CornerRadius,
  DesignElement,
  DesignDocument,
  Effect,
  ElementSizing,
  InstanceElement,
  Page,
  PaintStack,
  Stroke
} from "../dsl/types";
import { flattenElements, isContainer } from "../geometry/tree-ops";
import { resolveAxis } from "../geometry/resolve-axis";
import { instanceScaleOf, scaleCornerRadius, scaleEffect, scaleStrokeWidth } from "../geometry/scale-geometry";
import { topLayer } from "../dsl/paint-stack";
import { layoutOf } from "../dsl/layout-flat";
import { syncDualStorage } from "./style-sync";
import type { StyleTables } from "./style-tables";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The theme an instance renders under: its own declaration, else the master's,
 * else whatever the surrounding tree resolved to.
 *
 * The master's `themeMode` is part of what an instance inherits, exactly like its
 * fills and its box — it is how a whole page can be authored in dark while the
 * document's active theme stays light, and an instance that dropped it painted
 * half its own box dark (its `...master` merge carried the field) and every one
 * of its children light. `||` and not `??`: the field names a mode, and an empty
 * string names none.
 */
export function resolveInstanceTheme(
  inst: InstanceElement,
  master: ComponentElement | null | undefined,
  inheritedTheme: string
): string {
  return inst.themeMode || master?.themeMode || inheritedTheme;
}

/**
 * The NUMBER axis of the same rule: the instance's own `numberMode`, else the
 * master's, else whatever the surrounding tree resolved to. Symmetric with
 * `resolveInstanceTheme` because density is inherited by exactly the same
 * argument — a compact card keeps its spacing when it is placed on a
 * comfortable page, and a master authored compact stays compact.
 */
export function resolveInstanceNumberMode(
  inst: InstanceElement,
  master: ComponentElement | null | undefined,
  inheritedNumberMode: string
): string {
  return inst.numberMode || master?.numberMode || inheritedNumberMode;
}

/**
 * The ONE rule for what an instance inherits from its master: a field set on the
 * instance wins, an unset field falls through to the master.
 *
 * Presence — never truthiness — is the test. `fills: []` means "explicitly no
 * fill" and must NOT fall back to the master's, or deleting the last fill on an
 * instance silently resurrects the master's fill. The old code used
 * `inst.fills.length > 0 ? ... : master.fills` for fills and `||` for strokes,
 * which made the same gesture (remove the fill / remove the stroke) behave two
 * different ways.
 *
 * Scope: the instance's OWN box (width/height/fills/strokes/effects/borderRadius/
 * clipContent). Child-layer geometry is never inherited this way.
 */
export interface InstanceBox {
  width: number;
  height: number;
  /** Source fill stack BEFORE the per-layer `enabled` filter: defs are keyed by
   * position in this stack, so renderer and `<defs>` must index the same array. */
  fills: PaintStack;
  /** `fillEnabled !== false`. */
  fillsActive: boolean;
  strokes: Stroke[];
  borderRadius?: CornerRadius;
  cornerSmoothing?: number;
  clipContent: boolean;
  effects: Effect[];
  /**
   * Which shared style each stack is bound to, or `null` when the instance has
   * deliberately detached from it. Resolved, not stored: the Inspector reads
   * these to decide whether to show a binding pill or a plain value, and reading
   * them off the instance made an instance of a style-bound component read as a
   * component carrying its own copy — the same look the dual-storage invariant
   * exists to prevent. `null` is a real answer and must survive the merge, so
   * presence (`!== undefined`), not truthiness, is the test.
   */
  fillStyleId?: string | null;
  strokeStyleId?: string | null;
  textStyleId?: string | null;
  effectStyleId?: string | null;
}

/**
 * Resolves an instance's box against its master. Every consumer — the canvas
 * renderer, `CanvasDefs`, the inspector — reads this one function, because the
 * two independent render passes must agree: a gradient def emitted from a
 * different stack than the one the canvas indexes renders shifted, and it only
 * shows up when the master has a gradient and the instance has no fills of its
 * own. The renderer's old comment ("Mirrors `resolvedFills` in CanvasDefs")
 * existed because that rule was hand-copied in three places.
 */
export function resolveInstanceBox(
  inst: InstanceElement,
  master: ComponentElement,
  /**
   * The size `resolveInstanceContent`'s layout pass arrived at. It differs from
   * the stored box exactly when the master hugs that axis, and a caller that
   * paints must use it: laying the children out at one width and drawing the
   * instance's own chrome at another is what made a hugging tag clip its label.
   */
  size?: { width: number; height: number },
  /**
   * The modes the instance renders under. The master's box paints are cloned
   * outside the page subtree, so they have to be re-materialized here too — on
   * both axes: the colour one for the paints, the number one for its radii and
   * stroke weights.
   */
  options?: { theme?: string; numberMode?: string; tables?: StyleTables }
): InstanceBox {
  const fills = inst.fills !== undefined ? inst.fills : master.fills || [];
  // `??` and not a truthiness test: an instance carrying an EMPTY stack has
  // deliberately chosen "no stroke", which is not the same as inheriting one.
  const strokes: Stroke[] = inst.strokes ?? master.strokes ?? [];

  /**
   * A scaled instance's INHERITED chrome has to travel with its contents. The
   * master's radius, stroke weights and shadow blur are authored at 1x, and the
   * resolution is the only place that knows the factor — a value the instance
   * owns is already stored at its own size and must not be multiplied again.
   */
  const scale = instanceScaleOf(inst);
  const k = Math.min(scale.x, scale.y);
  const scaledBox = k !== 1;

  const resolved: InstanceBox = {
    width: size?.width ?? inst.width ?? master.width,
    height: size?.height ?? inst.height ?? master.height,
    fills,
    fillsActive: inst.fillEnabled !== false,
    strokes:
      inst.strokes === undefined && scaledBox
        ? strokes.map((s) => scaleStrokeWidth(s, k))
        : strokes,
    borderRadius:
      inst.borderRadius !== undefined
        ? inst.borderRadius
        : scaledBox
          ? scaleCornerRadius(master.borderRadius, k)
          : master.borderRadius,
    cornerSmoothing:
      (inst as { cornerSmoothing?: number }).cornerSmoothing !== undefined
        ? (inst as { cornerSmoothing?: number }).cornerSmoothing
        : (master as { cornerSmoothing?: number }).cornerSmoothing,
    clipContent: inst.clipContent !== undefined ? inst.clipContent : Boolean(master.clipContent),
    effects:
      inst.effects === undefined && scaledBox
        ? (master.effects || []).map((e) => scaleEffect(e, scale.x, scale.y, k))
        : inst.effects !== undefined
          ? inst.effects
          : master.effects || [],
    // `!== undefined` rather than `??`: detaching writes an explicit `null`, and
    // `??` would treat it as absent and hand back the master's binding — the
    // detach would look like it never happened.
    fillStyleId: inst.fillStyleId !== undefined ? inst.fillStyleId : master.fillStyleId,
    strokeStyleId: inst.strokeStyleId !== undefined ? inst.strokeStyleId : master.strokeStyleId,
    textStyleId: (inst as { textStyleId?: string | null }).textStyleId !== undefined
      ? (inst as { textStyleId?: string | null }).textStyleId
      : (master as { textStyleId?: string | null }).textStyleId,
    effectStyleId:
      inst.effectStyleId !== undefined ? inst.effectStyleId : master.effectStyleId
  };
  // A scaled instance's inherited stroke and shadow no longer match the styles
  // they came from — `syncDualStorage` below would re-materialise the 1x widths
  // and blurs over the scaled ones. The colour tokens inside the stacks survive,
  // which is what keeps a scaled instance answering Light / Dark.
  if (scaledBox) {
    if (inst.strokes === undefined) resolved.strokeStyleId = undefined;
    if (inst.effects === undefined) resolved.effectStyleId = undefined;
  }
  if (options?.theme && options.tables) {
    // `themeMode` is written explicitly, not left to the `...master` spread: that
    // spread is how the instance's own box used to keep a dark fill while every
    // child under it re-materialised as light. The instance's declaration wins,
    // the master's is the fallback, and `options.theme` is what `syncDualStorage`
    // falls back to when neither says anything. `numberMode` follows the same
    // rule on its own axis.
    const synced = syncDualStorage(
      {
        ...master,
        ...resolved,
        themeMode: inst.themeMode ?? master.themeMode,
        numberMode: inst.numberMode ?? master.numberMode,
        children: []
      } as unknown as DesignElement,
      options.tables,
      options.theme,
      options.numberMode ?? options.theme
    );
    resolved.fills = synced.fills ?? [];
    resolved.strokes = synced.strokes ?? [];
    resolved.effects = synced.effects ?? [];
  }
  return resolved;
}

/**
 * The fills that actually paint, in source-stack order: the enabled layers of a
 * box whose fill was not switched off entirely.
 */
export function activeInstanceFills(box: InstanceBox): PaintStack {
  if (!box.fillsActive) return [];
  return box.fills.filter((f) => f && f.enabled !== false);
}

/**
 * An element's paint stack, resolved — the ONE answer to "which fills does this
 * element paint", for the two passes that have to agree on it.
 *
 * `CanvasDefs` indexes gradient and pattern defs by position in this stack and
 * the renderer looks them up by the same position, so a second spelling of the
 * rule here would point a gradient at the wrong def — visible only when a master
 * carries one and its instance does not.
 */
export function resolvedPaintStack(el: DesignElement, box: InstanceBox | null): PaintStack {
  if (el.type === "instance") {
    if (!box) return el.fills || [];
    return box.fillsActive ? box.fills : [];
  }
  return el.fills && el.fills.length > 0 ? el.fills : [];
}

/**
 * Copies a resized master's box and sizing onto the instances that never sized
 * themselves.
 *
 * An instance's `width/height` used to be a snapshot taken at creation, so
 * resizing a master left every existing instance at the old size while its contents
 * reflowed to the new one. The model's rule is inheritance — an instance that has
 * never set its own size follows its master, and one the user resized carries
 * `sizeOverride` and keeps it.
 *
 * `sizing` travels with the box because `resolveAxis` reads it, and an instance
 * that is not told what the master declares is left reporting the mode it was
 * minted with: a master switched from Fixed to Hug left every existing instance
 * still reading Fixed while the canvas painted it hugging, and the size menu
 * disagreed with the canvas. An axis the instance HAS declared is left alone —
 * that is the user's, and the one place per-axis control comes from.
 *
 * Keyed on the master's box or sizing CHANGING between two commits, not on a
 * global pass: a differing size in an already-saved document therefore survives
 * loading (it cannot be told apart from a deliberate resize), and only an actual
 * master resize re-points the instances. Every write in the app funnels through
 * `EditorStore.commit`, which is what makes "between two commits" well defined —
 * including gesture frames, which are transient commits of their own.
 */
export function propagateMasterSize(prev: DesignDocument, next: DesignDocument): DesignDocument {
  const resized = resizedComponents(prev, next);
  if (resized.size === 0) return next;

  const pages: Page[] = next.pages && next.pages.length > 0 ? next.pages : [];
  if (pages.length === 0) return next;

  let changed = false;
  const nextPages = pages.map((page) => {
    const elements = mapInstances(page.children || [], null, (inst, parent) => {
      if (inst.sizeOverride) return inst;
      const box = resized.get(inst.componentId);
      if (!box) return inst;
      // An axis the parent's layout owns (fill / hug) belongs to that layout, not
      // to the master — the same axis a canvas resize refuses to drag.
      const owns = (axis: "width" | "height") => Boolean(parent && layoutOf(parent)) && resolveAxis(inst, parent, axis) !== "fixed";
      // A scaled instance follows its master's box THROUGH its factor: the
      // master's new size is the 1x number the factor was authored against, so
      // copying it across unchanged would shrink the factor's meaning by exactly
      // the resize.
      const scale = instanceScaleOf(inst);
      const scaled = scale.x !== 1 || scale.y !== 1;
      const width = owns("width") ? inst.width : scaled ? round2(box.width * scale.x) : box.width;
      const height = owns("height") ? inst.height : scaled ? round2(box.height * scale.y) : box.height;
      const sizing = inheritedSizing(inst.sizing, box.sizing);
      if (width === inst.width && height === inst.height && sizing === inst.sizing) return inst;
      changed = true;
      return { ...inst, width, height, sizing };
    });
    return elements === page.children ? page : { ...page, children: elements };
  });
  if (!changed) return next;

  return { ...next, pages: nextPages };
}

/**
 * The master's sizing with the instance's own declarations laid over it. Returns
 * the instance's own object when the merge changes nothing, so an instance that
 * is already in sync is not rewritten on every master resize.
 */
function inheritedSizing(
  own: ElementSizing | undefined,
  master: ElementSizing | undefined
): ElementSizing | undefined {
  const merged: ElementSizing = { ...(master ?? {}) };
  if (own?.width !== undefined) merged.width = own.width;
  if (own?.height !== undefined) merged.height = own.height;
  if (merged.width === own?.width && merged.height === own?.height) return own;
  return merged.width === undefined && merged.height === undefined ? undefined : merged;
}

/** `mapElements` for instances only, carrying the parent each one sits in. */
function mapInstances(
  elements: DesignElement[],
  parent: ContainerElement | null,
  fn: (inst: InstanceElement, parent: ContainerElement | null) => InstanceElement
): DesignElement[] {
  let changed = false;
  const out = elements.map((el) => {
    let next: DesignElement = el.type === "instance" ? fn(el as InstanceElement, parent) : el;
    if (isContainer(next)) {
      const children = (next as ContainerElement).children;
      if (children && children.length > 0) {
        const mapped = mapInstances(children, next as ContainerElement, fn);
        if (mapped !== children) next = { ...next, children: mapped } as DesignElement;
      }
    }
    if (next !== el) changed = true;
    return next;
  });
  return changed ? out : elements;
}

/**
 * The components a page defines, by id, cached on the page object.
 *
 * A page is immutable, so the index can never describe a tree that has since
 * changed; and both sides of the comparison below read it, so a commit that
 * touched one page no longer walks every other page to find out.
 */
const pageComponentIndex = new WeakMap<Page, Map<string, ComponentElement>>();

function componentsOfPage(page: Page): Map<string, ComponentElement> {
  const hit = pageComponentIndex.get(page);
  if (hit) return hit;
  const index = new Map<string, ComponentElement>();
  for (const el of flattenElements(page.children || [])) {
    if (el.type === "component") index.set(el.id, el as ComponentElement);
  }
  pageComponentIndex.set(page, index);
  return index;
}

/** Components whose box or sizing differs between the two states, by id. */
function resizedComponents(
  prev: DesignDocument,
  next: DesignDocument
): Map<string, { width: number; height: number; sizing?: ElementSizing }> {
  const before = new Map<string, ComponentElement>();
  for (const page of prev.pages ?? []) {
    for (const [id, el] of componentsOfPage(page)) before.set(id, el);
  }

  const out = new Map<string, { width: number; height: number; sizing?: ElementSizing }>();
  // A page object present in both documents is the same page: nothing on it can
  // have moved, so re-walking its 1,841 elements answers "no change" every time.
  const untouched = new Set(prev.pages ?? []);
  for (const page of next.pages ?? []) {
    if (untouched.has(page)) continue;
    for (const [id, el] of componentsOfPage(page)) {
      const was = before.get(id);
      if (was && was.width === el.width && was.height === el.height && sameSizing(was.sizing, el.sizing)) continue;
      out.set(id, { width: el.width, height: el.height, sizing: el.sizing });
    }
  }
  return out;
}

/** `sizing` identity by value — two axes, so there is nothing to compare but the pair. */
function sameSizing(a: ElementSizing | undefined, b: ElementSizing | undefined): boolean {
  return a?.width === b?.width && a?.height === b?.height;
}
