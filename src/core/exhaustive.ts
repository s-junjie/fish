/**
 * Marks a spot that must be unreachable, for the switches where a missed case
 * fails *silently*.
 *
 * The union members here are closed, and the type system already refuses to
 * assign an unknown value — but a `default:` branch absorbs the next member
 * without a word. An element type that reaches the layer panel's icon fallback
 * looks like a plain square; an effect that reaches the scale fallback keeps its
 * size. Both read as the user's own mistake, so the guard is worth its call:
 * leaving a case out becomes a compile error instead.
 *
 * Deliberately does nothing at runtime — a value that got here anyway (a hand
 * edited file, an `as any`) must keep taking the branch's own fallback rather
 * than throw in a UI path.
 */
export function expectNever(value: never): void {
  void value;
}
