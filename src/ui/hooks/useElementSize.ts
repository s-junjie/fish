import { useEffect, useState } from "preact/hooks";

/**
 * Tracks an element's border-box size. Reading `getBoundingClientRect()` inside
 * a render body forces a synchronous layout flush on every frame; observing the
 * size instead keeps the read out of the render path.
 */
export function useElementSize(ref: { current: HTMLElement | null }) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height }
      );
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return size;
}
