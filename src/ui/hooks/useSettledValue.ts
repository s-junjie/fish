import { useEffect, useState } from "preact/hooks";

/**
 * `value`, but only once it has held still for `delayMs`.
 *
 * For work that is correct at any value but too expensive to redo while the
 * value is still moving — a wheel gesture delivers a dozen values a second, and
 * the last one is the only one the user looks at.
 */
export function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (settled === value) return;
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, settled, delayMs]);
  return settled;
}
