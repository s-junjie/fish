/**
 * Collapses a burst of high-rate input events into one apply per animation
 * frame, keeping only the latest value. Absolute-delta gestures (drag, resize,
 * rotate) are safe to collapse because they recompute from a fixed origin;
 * call `flush()` before committing a gesture so the final position is never
 * dropped.
 */
export function createRafCoalescer<T>(apply: (value: T) => void) {
  let pending: T | undefined;
  let frame = 0;

  const run = () => {
    frame = 0;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    apply(value);
  };

  return {
    push(value: T) {
      pending = value;
      if (frame === 0) frame = requestAnimationFrame(run);
    },
    flush() {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      run();
    }
  };
}
