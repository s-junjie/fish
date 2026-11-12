import { DesignElement } from "../dsl/types";
import { Rect } from "../geometry/bounds";
import { isContainer } from "../geometry/tree-ops";
import { textPaintsOneLine } from "../layout/text-sizing";

export interface MorphPair {
  /** The name both halves share — the whole of the identity that carries. */
  name: string;
  fromId: string;
  toId: string;
  /** Boxes local to their own slide; add the slide's x/y to place them. */
  from: Rect;
  to: Rect;
  /**
   * The start point the way the target ELEMENT stores it: local to its own
   * parent, not to the slide.
   *
   * `from` carries the parent's offset so the overlay can draw a line across the
   * canvas, but a pair is written back as a local coordinate — using `from`
   * there displaced every nested layer by its parent's `x`/`y`, which is why
   * nested pairs were once switched off altogether.
   */
  fromLocal: { x: number; y: number };
  /**
   * Resolved opacities, so a pair the author also faded interpolates like a box.
   *
   * There is deliberately no `type`: the two halves need not agree on one, and a
   * single field would have to pick a side and then lie about the other.
   */
  fromOpacity: number;
  toOpacity: number;
  /** 0 is a direct child of a slide. */
  depth: number;
  /**
   * Both halves paint ONE line, so the flight has to as well.
   *
   * A text's wrap is decided by a box and a run that do not travel together:
   * the box interpolates, but the run is the INCOMING one from frame one (its
   * string, its family, its weight, its runs). Anywhere those two disagree the
   * paragraph breaks mid-flight and unbreaks at the end — and a line count is
   * discrete, so what the audience sees is the block flickering through two or
   * three lines that neither slide has.
   *
   * When both halves are one line there is nothing to break: the only truthful
   * intermediate is one line, so the player forbids the soft wrap and lets the
   * glyphs overrun the box for a few frames. A pair whose halves disagree (one
   * line leaving, three arriving) is a real reflow of the layout, and it keeps
   * the browser's own progressive answer.
   */
  oneLine: boolean;
  fromEl?: DesignElement;
  toEl?: DesignElement;
}

export interface MorphSolo {
  id: string;
  name: string | undefined;
  box: Rect;
  depth: number;
  /**
   * The element it hung off on the OUTGOING slide, or null for the slide itself.
   *
   * Carried because `box` is absolute within the slide and an injected layer has
   * to be put back inside the parent that clips it — lifted to the top level it
   * escapes a container's `overflow` and, worse, lands in a list where it
   * paints above everything instead of where the author left it.
   */
  parentId: string | null;
  /** Index among its own siblings on the outgoing slide: where it paints. */
  order: number;
  /**
   * The layer itself. Carried because an outgoing layer has to be PAINTED while
   * it leaves — it is not in the incoming slide's tree, so a match that only
   * recorded its id could describe a fade-out it cannot draw.
   */
  el: DesignElement;
}

export interface MorphMatch {
  /** Paired layers, parents before their own children. */
  pairs: MorphPair[];
  /** On the outgoing slide only: fade out where it stands. */
  exits: MorphSolo[];
  /** On the incoming slide only: fade in where it lands. */
  enters: MorphSolo[];
}

/**
 * The identity a layer carries from one slide to the next: its NAME, and nothing
 * else.
 *
 * NAME, not id: element ids are unique per document, so a duplicated slide
 * hands every child a new one and nothing would ever match — which is exactly
 * the "copy a slide, move a thing, get the animation for free" gesture this has
 * to support. A duplicated slide keeps its children's names, so the pair is
 * already there before the author asks for it. Bento gets the same result from a
 * shared id because its slides are not copies of one node in a tree; FISH's are.
 *
 * The TYPE is deliberately NOT part of it. The reshape is one of the two things
 * a morph is for — a rect that becomes an ellipse, a dot that becomes a bar —
 * and what travels is the box, the alpha and whatever numeric fields the two
 * halves share, none of which depends on the type. What the audience sees at
 * the end is the layer the author drew on
 * the slide it lands on, because that is the element the walk interpolates and
 * the player paints. Putting the type in the key refused exactly that gesture,
 * and refused it in silence.
 *
 * The name is trimmed at its ends and otherwise compared as written: `Hero` and
 * `hero` are two different layers. `null` means never pairs — an unnamed layer
 * has no identity to carry, so it fades out and its counterpart fades in, which
 * is the honest answer for a layer the author has not named.
 */
function matchKey(el: DesignElement): string | null {
  return el.name?.trim() || null;
}

/** Absent alpha means opaque; a pair interpolates the two resolved numbers. */
const opacityOf = (el: DesignElement): number => el.opacity ?? 1;

const ZERO = { x: 0, y: 0 };

/**
 * A layer's own x/y is local to its PARENT, so every box is reported after the
 * whole chain above it has been added — a nested pair that ignored its parent
 * would draw its line from the slide's origin and land a panel's height away
 * from the layer it names.
 */
function boxOf(el: DesignElement, shift: { x: number; y: number }): Rect {
  return { x: el.x + shift.x, y: el.y + shift.y, width: el.width, height: el.height };
}

function solo(
  el: DesignElement,
  depth: number,
  shift: { x: number; y: number },
  parentId: string | null,
  order: number
): MorphSolo {
  return { id: el.id, name: el.name, box: boxOf(el, shift), depth, parentId, order, el };
}

/** One sibling slot: the layer, and where it sat among its parent's children. */
interface Sibling {
  el: DesignElement;
  order: number;
}

interface Partition {
  groups: Map<string, Sibling[]>;
  /** Named nowhere, so they carry nothing across: they fade where they stand. */
  unnamed: Sibling[];
}

function partition(list: DesignElement[]): Partition {
  const groups = new Map<string, Sibling[]>();
  const unnamed: Sibling[] = [];
  for (const [order, el] of list.entries()) {
    if (el.visible === false) continue;
    const key = matchKey(el);
    if (key === null) {
      unnamed.push({ el, order });
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push({ el, order });
    else groups.set(key, [{ el, order }]);
  }
  return { groups, unnamed };
}

/**
 * Pair two slides' layers by NAME, recursing into a pair's children only once
 * the parents have matched — a child of an unmatched parent has no place to
 * travel from, so claiming a pair for it would animate it out of a container
 * that never moved.
 *
 * A container that pairs still hands its CHILDREN their own pairs: a stage frame
 * that is the same on both slides is the frame the cards inside it move within,
 * and freezing them made the whole fan pop at the first frame. Each child
 * interpolates in its own parent's space, so the two motions compose instead of
 * competing.
 *
 * The walk descends into whichever side is a container, because the two halves
 * may not be the same kind of thing: a group that becomes a rect has children
 * that can only leave, and a rect that becomes a group has children that can
 * only arrive.
 */
export function matchSlides(from: DesignElement, to: DesignElement): MorphMatch {
  const pairs: MorphPair[] = [];
  const exits: MorphSolo[] = [];
  const enters: MorphSolo[] = [];

  const walk = (
    fromChildren: DesignElement[],
    toChildren: DesignElement[],
    depth: number,
    fromShift: { x: number; y: number },
    toShift: { x: number; y: number },
    parentId: string | null
  ) => {
    const fromSplit = partition(fromChildren);
    const toSplit = partition(toChildren);
    const fromGroups = fromSplit.groups;
    const toGroups = toSplit.groups;

    for (const { el, order } of fromSplit.unnamed) exits.push(solo(el, depth, fromShift, parentId, order));
    for (const { el, order } of toSplit.unnamed) enters.push(solo(el, depth, toShift, parentId, order));

    for (const [key, fromList] of fromGroups) {
      const toList = toGroups.get(key);
      if (!toList) {
        for (const { el, order } of fromList) exits.push(solo(el, depth, fromShift, parentId, order));
        continue;
      }
      // Two layers with the same name on one slide pair in document order; the
      // odd one out is a layer the author did not mean to animate.
      const shared = Math.min(fromList.length, toList.length);
      for (let i = 0; i < shared; i++) {
        const a = fromList[i].el;
        const b = toList[i].el;
        pairs.push({
          name: a.name!.trim(),
          fromId: a.id,
          toId: b.id,
          from: boxOf(a, fromShift),
          to: boxOf(b, toShift),
          fromLocal: { x: a.x, y: a.y },
          fromOpacity: opacityOf(a),
          toOpacity: opacityOf(b),
          depth,
          oneLine: a.type === "text" && b.type === "text" && textPaintsOneLine(a) && textPaintsOneLine(b),
          fromEl: a,
          toEl: b
        });
        // Either side may be a container on its own: a pair of different types
        // still has children, and they are not pairs — they only leave or only
        // arrive, so walking them with an empty list on the other side is what
        // gives them a fade instead of a pop.
        if (isContainer(a) || isContainer(b)) {
          walk(
            isContainer(a) ? a.children || [] : [],
            isContainer(b) ? b.children || [] : [],
            depth + 1,
            { x: fromShift.x + a.x, y: fromShift.y + a.y },
            { x: toShift.x + b.x, y: toShift.y + b.y },
            a.id
          );
        }
      }
      for (let i = shared; i < fromList.length; i++)
        exits.push(solo(fromList[i].el, depth, fromShift, parentId, fromList[i].order));
      for (let i = shared; i < toList.length; i++)
        enters.push(solo(toList[i].el, depth, toShift, parentId, toList[i].order));
      toGroups.delete(key);
    }

    for (const toList of toGroups.values()) {
      for (const { el, order } of toList) enters.push(solo(el, depth, toShift, parentId, order));
    }
  };

  if (isContainer(from) && isContainer(to)) {
    walk(from.children || [], to.children || [], 0, ZERO, ZERO, null);
  }
  return { pairs, exits, enters };
}
