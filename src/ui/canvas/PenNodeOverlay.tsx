import { useEffect, useRef, useState } from "preact/hooks";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { PathElement } from "../../core/dsl/types";
import {
  parsePathData,
  serializePathData,
  removeAnchor,
  EditablePath,
  Pt
} from "../../core/geometry/path-data";
import { insertAnchorAt, nearestPointOnPath, PathHit } from "../../core/geometry/path-ops";
import { invert, matrixToSvg, transformPoint, type Matrix2D } from "../../core/geometry/matrix";
import { PenMode } from "../../core/tools";
import { CANVAS_SELECT, CANVAS_COMPONENT, CANVAS_ON_SELECT } from "./canvas-colors";

/** A path the pen may edit, with its geometry coordinates placed on the canvas. */
export interface PenTarget {
  element: PathElement;
  /**
   * This path's geometry coordinates → canvas, ancestors' turns included. Not an
   * origin to subtract from `x`/`y`: a path inside a turned frame stores its
   * anchors relative to itself and is PAINTED inside the frame's turned `<g>`, so
   * resolving against the translation alone aims the pen at a place the outline
   * is not.
   */
  matrix: Matrix2D;
}

interface PenNodeOverlayProps {
  mode: Exclude<PenMode, "draw">;
  zoom: number;
  pan: { x: number; y: number };
  containerRef: { current: HTMLDivElement | null };
  targets: PenTarget[];
  onEditPath: (id: string, newD: string) => void;
  onExit: () => void;
}

interface Hover {
  target: PenTarget;
  model: EditablePath;
  /** Nearest anchor, and how far the cursor is from it. */
  anchorIdx: number;
  anchorDist: number;
  /** Nearest point along the outline, and how far the cursor is from it. */
  pathHit: PathHit | null;
  pathDist: number;
  /** The cursor in the path's own local coordinates. */
  local: Pt;
}

const distanceTo = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The pen's add / remove modes, over paths that already exist.
 *
 * Figma reaches these by pointing the pen at a shape and cycling its cursor; the
 * cursor state here is the same three-state cycle, with `draw` handled by
 * `PenDrawOverlay` and these two modes by this one. Both work by resolving the
 * path under the cursor first, so the modes stay usable on a crowded canvas
 * without having to select the path first.
 */
export function PenNodeOverlay({
  mode,
  zoom,
  pan,
  containerRef,
  targets,
  onEditPath,
  onExit
}: PenNodeOverlayProps) {
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverRef = useRef<Hover | null>(null);
  hoverRef.current = hover;

  const getWorldCoords = (e: MouseEvent): Pt => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom
    };
  };

  /** The target whose outline is closest to the cursor, within one handle's reach. */
  const resolve = (world: Pt, reach: number): Hover | null => {
    let best: Hover | null = null;
    for (const target of targets) {
      const model = parsePathData(target.element.d || "");
      if (!model || model.anchors.length === 0) continue;
      // Through the same matrix the overlay draws under, so "near the cursor"
      // and "drawn under the cursor" are the same claim.
      const inv = invert(target.matrix);
      if (!inv) continue;
      const local = transformPoint(inv, world);

      let anchorIdx = 0;
      let anchorDist = Infinity;
      model.anchors.forEach((p, i) => {
        const d = distanceTo(local, p);
        if (d < anchorDist) {
          anchorDist = d;
          anchorIdx = i;
        }
      });
      const pathHit = nearestPointOnPath(model, local);
      const pathDist = pathHit ? pathHit.dist : Infinity;
      if (Math.min(anchorDist, pathDist) > reach) continue;
      if (best && Math.min(best.anchorDist, best.pathDist) <= Math.min(anchorDist, pathDist)) continue;
      best = { target, model, anchorIdx, anchorDist, pathHit, pathDist, local };
    }
    return best;
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // One handle radius: past that the cursor is not "on" the path, and the
      // mode should read as inactive instead of editing whatever is nearby.
      const found = resolve(getWorldCoords(e), 8 / zoom);
      setHover((prev) => {
        if (!found && !prev) return prev;
        if (found && prev && found.target.element.id === prev.target.element.id) {
          const same =
            found.anchorIdx === prev.anchorIdx &&
            Math.abs(found.anchorDist - prev.anchorDist) < 0.01 &&
            Math.abs(found.pathDist - prev.pathDist) < 0.01;
          if (same) return prev;
        }
        return found;
      });
    };
    const onLeave = () => setHover(null);
    // `mouseleave` on the document, NOT `mouseout`: mouseout bubbles, so every
    // element the cursor crossed on its way to the outline fired it and wiped the
    // hover the same event had just set.
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("mousemove", onMove);
    };
    // `targets` is rebuilt every render; the resolver only reads it, so keying on
    // its contents (not its identity) keeps the listener from re-binding per frame.
  }, [zoom, pan.x, pan.y, targets.map((t) => t.element.d).join("|")]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onExit();
    }
  };
  useWindowKeydown(onKeyDown, [onExit]);

  const apply = () => {
    const h = hoverRef.current;
    if (!h) return;
    // The edit is undone by switching tools, not by an Escape here: Escape is how
    // the user leaves the pen, and spending it on a no-op edit would strand them.
    if (mode === "remove") {
      if (h.anchorDist > 8 / zoom) return;
      const next = removeAnchor(h.model, h.anchorIdx);
      if (next.anchors.length === 0) return;
      onEditPath(h.target.element.id, serializePathData(next));
      return;
    }
    if (!h.pathHit) return;
    const next = insertAnchorAt(h.model, h.pathHit.segIdx, h.pathHit.t);
    onEditPath(h.target.element.id, serializePathData(next));
  };

  const anchorR = 3.5 / zoom;
  const controlR = 2.5 / zoom;
  const strokeW = 1 / zoom;
  const reach = 8 / zoom;
  const armed = hover
    ? mode === "remove"
      ? hover.anchorDist <= reach
      : hover.pathHit !== null
    : false;

  return (
    <g data-pen-mode={mode} data-pen-hover={hover ? "yes" : "no"} className="cursor-crosshair" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); apply(); }}>
      <rect x={-50000} y={-50000} width={100000} height={100000} fill="transparent" />

      {hover && (
        <g transform={matrixToSvg(hover.target.matrix)}>
          <path
            d={hover.target.element.d}
            fill="none"
            stroke={armed ? CANVAS_SELECT : CANVAS_SELECT}
            strokeOpacity={armed ? 0.9 : 0.35}
            strokeWidth={strokeW * 1.5}
            pointerEvents="none"
          />

          {hover.model.anchors.map((p, i) => {
            const near = distanceTo(hover.local, p) <= reach;
            const live = mode === "remove" && near;
            return (
              <circle
                key={`pen_anchor_${i}`}
                data-pen-anchor-index={i}
                cx={p.x}
                cy={p.y}
                r={live ? anchorR * 1.3 : anchorR}
                fill={live ? CANVAS_SELECT : CANVAS_ON_SELECT}
                stroke={live ? CANVAS_ON_SELECT : CANVAS_SELECT}
                strokeWidth={strokeW * 1.2}
                pointerEvents="none"
              />
            );
          })}

          {/* Where a click would land in add mode: on the outline, not on an anchor. */}
          {mode === "add" && hover.pathHit && hover.anchorDist > reach && (
            <g pointerEvents="none">
              <line
                x1={hover.pathHit.point.x - 4 / zoom}
                y1={hover.pathHit.point.y}
                x2={hover.pathHit.point.x + 4 / zoom}
                y2={hover.pathHit.point.y}
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
              <line
                x1={hover.pathHit.point.x}
                y1={hover.pathHit.point.y - 4 / zoom}
                x2={hover.pathHit.point.x}
                y2={hover.pathHit.point.y + 4 / zoom}
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
              <circle cx={hover.pathHit.point.x} cy={hover.pathHit.point.y} r={controlR} fill={CANVAS_SELECT} stroke={CANVAS_ON_SELECT} strokeWidth={strokeW * 0.75} />
            </g>
          )}
        </g>
      )}
    </g>
  );
}
