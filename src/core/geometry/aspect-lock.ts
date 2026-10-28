import { DesignElement } from "../dsl/types";

/**
 * The proportion lock is a property of an element, not of a session.
 *
 * It used to be one `useState` boolean shared by the whole document, which made
 * three things true that none of them should be: locking a rectangle locked
 * whatever was drawn next, and an image arrived on canvas already unlocked until
 * the user noticed. `LayoutConstraints.preserveAspectRatio` is the field the DSL
 * already declared for exactly this and no UI ever wrote, so the state moves
 * onto the element and the session flag is gone.
 *
 * A newly created element therefore gets the lock its own type implies and
 * nothing else — the inheritance the old flag had is the bug, not a default.
 * An image, and only an image, is the case that warrants one: a bitmap crops
 * and letterboxes to fill its box, so a free resize stretches or squashes the
 * subject, while a drawn shape's geometry is authored in the box it was drawn
 * into and locking it would fight every corner drag.
 *
 * That rule holds by the field being absent, so nothing has to compute it: the
 * element factory writes no `preserveAspectRatio`, and `isAspectLocked` reads
 * absence as unlocked.
 */

/** Whether this element constrains its own width/height ratio. */
export function isAspectLocked(el: DesignElement | null | undefined): boolean {
  return el?.constraints?.preserveAspectRatio === true;
}

export function withAspectLock<T extends DesignElement>(el: T, locked: boolean): T {
  if (locked) {
    return { ...el, constraints: { ...el.constraints, preserveAspectRatio: true } };
  }
  // Deleting the key rather than writing `false`, so an untouched element and an
  // explicitly unlocked one have the same document — the field's meaning is
  // "constrains", and absence already says that.
  if (!el.constraints || el.constraints.preserveAspectRatio === undefined) return el;
  const { preserveAspectRatio, ...rest } = el.constraints;
  return { ...el, constraints: rest };
}
