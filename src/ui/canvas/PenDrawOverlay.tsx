import { useState, useRef, useEffect } from "preact/hooks";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { Pt, EditablePath, normalizePathOrigin, serializePathData } from "../../core/geometry/path-data";
import { CANVAS_PREVIEW, CANVAS_SELECT, CANVAS_COMPONENT, CANVAS_ON_SELECT } from "./canvas-colors";

export interface PenDraftPoint {
  x: number;
  y: number;
  handleIn?: Pt;
  handleOut?: Pt;
}

interface PenDrawOverlayProps {
  zoom: number;
  pan: { x: number; y: number };
  containerRef: { current: HTMLDivElement | null };
  onFinishDraft: (newElementData: { x: number; y: number; width: number; height: number; d: string }) => void;
  onCancelDraft: () => void;
}

export function PenDrawOverlay({
  zoom,
  pan,
  containerRef,
  onFinishDraft,
  onCancelDraft
}: PenDrawOverlayProps) {
  const [points, setPoints] = useState<PenDraftPoint[]>([]);
  const [activeMouse, setActiveMouse] = useState<Pt | null>(null);
  const [isHoveringFirst, setIsHoveringFirst] = useState(false);
  const isDragging = useRef(false);

  const getWorldCoords = (e: MouseEvent): Pt => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) - pan.x) / zoom * 10) / 10,
      y: Math.round(((e.clientY - rect.top) - pan.y) / zoom * 10) / 10
    };
  };

  const commitPath = (pts: PenDraftPoint[], closed: boolean) => {
    if (pts.length < 2) {
      onCancelDraft();
      return;
    }

    const anchors: Pt[] = pts.map((p) => ({ x: p.x, y: p.y }));
    const segments: any[] = [];

    for (let i = 0; i < pts.length - 1; i++) {
      const prev = pts[i];
      const cur = pts[i + 1];
      if (prev.handleOut || cur.handleIn) {
        segments.push({
          kind: "cubic",
          a: i,
          b: i + 1,
          ca: prev.handleOut ? { ...prev.handleOut } : { x: prev.x, y: prev.y },
          cb: cur.handleIn ? { ...cur.handleIn } : { x: cur.x, y: cur.y }
        });
      } else {
        segments.push({ kind: "line", a: i, b: i + 1 });
      }
    }

    if (closed && pts.length > 2) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      if (last.handleOut || first.handleIn) {
        segments.push({
          kind: "cubic",
          a: pts.length - 1,
          b: 0,
          ca: last.handleOut ? { ...last.handleOut } : { x: last.x, y: last.y },
          cb: first.handleIn ? { ...first.handleIn } : { x: first.x, y: first.y }
        });
      } else {
        segments.push({ kind: "line", a: pts.length - 1, b: 0 });
      }
    }

    const rawPath: EditablePath = { anchors, segments, closed };
    const { normalized, offsetX, offsetY, width, height } = normalizePathOrigin(rawPath);
    const d = serializePathData(normalized);

    onFinishDraft({
      x: offsetX,
      y: offsetY,
      width,
      height,
      d
    });
  };

  // Keyboard actions: Enter/Esc to complete/cancel, Backspace to undo point
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    if (e.key === "Enter") {
      e.preventDefault();
      commitPath(points, false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (points.length >= 2) {
        commitPath(points, false);
      } else {
        onCancelDraft();
      }
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (points.length <= 1) {
        onCancelDraft();
      } else {
        setPoints((prev) => prev.slice(0, -1));
      }
    }
  };
  useWindowKeydown(handleKeyDown, [points]);

  // Global mouse move & mouse up for drawing and dragging handles
  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      const world = getWorldCoords(e);

      if (isDragging.current) {
        setPoints((prev) => {
          if (prev.length === 0) return prev;
          const lastIdx = prev.length - 1;
          const last = prev[lastIdx];
          const dx = world.x - last.x;
          const dy = world.y - last.y;
          const updated = [...prev];
          updated[lastIdx] = {
            ...last,
            handleOut: { x: Math.round((last.x + dx) * 10) / 10, y: Math.round((last.y + dy) * 10) / 10 },
            handleIn: { x: Math.round((last.x - dx) * 10) / 10, y: Math.round((last.y - dy) * 10) / 10 }
          };
          return updated;
        });
      } else {
        setActiveMouse(world);
        if (points.length >= 2) {
          const first = points[0];
          const dist = Math.hypot(world.x - first.x, world.y - first.y);
          setIsHoveringFirst(dist <= 10 / zoom);
        } else {
          setIsHoveringFirst(false);
        }
      }
    };

    const handleWindowMouseUp = () => {
      isDragging.current = false;
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [points, zoom, pan]);

  const handlePointerDown = (e: any) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const world = getWorldCoords(e);

    // If clicking close to the first anchor point, close path!
    if (isHoveringFirst && points.length >= 2) {
      commitPath(points, true);
      return;
    }

    const newPt: PenDraftPoint = { x: world.x, y: world.y };
    setPoints((prev) => [...prev, newPt]);
    isDragging.current = true;
  };

  const anchorR = 3.5 / zoom;
  const controlR = 2.5 / zoom;
  const strokeW = 1 / zoom;

  // Build SVG path for placed segments
  const pathParts: string[] = [];
  if (points.length > 0) {
    pathParts.push(`M ${points[0].x} ${points[0].y}`);
    for (let i = 0; i < points.length - 1; i++) {
      const prev = points[i];
      const cur = points[i + 1];
      if (prev.handleOut || cur.handleIn) {
        const ca = prev.handleOut || prev;
        const cb = cur.handleIn || cur;
        pathParts.push(`C ${ca.x} ${ca.y} ${cb.x} ${cb.y} ${cur.x} ${cur.y}`);
      } else {
        pathParts.push(`L ${cur.x} ${cur.y}`);
      }
    }
  }

  // Rubber-band preview segment to mouse
  let rubberBandD = "";
  if (points.length > 0 && activeMouse && !isDragging.current) {
    const last = points[points.length - 1];
    const target = isHoveringFirst && points.length >= 2 ? points[0] : activeMouse;
    if (last.handleOut) {
      rubberBandD = `M ${last.x} ${last.y} C ${last.handleOut.x} ${last.handleOut.y} ${target.x} ${target.y} ${target.x} ${target.y}`;
    } else {
      rubberBandD = `M ${last.x} ${last.y} L ${target.x} ${target.y}`;
    }
  }

  return (
    <g className="cursor-crosshair" onMouseDown={handlePointerDown}>
      {/* Invisible global capture surface */}
      <rect
        x={-50000}
        y={-50000}
        width={100000}
        height={100000}
        fill="transparent"
      />

      {/* Committed draft path */}
      {pathParts.length > 0 && (
        <path
          d={pathParts.join(" ")}
          fill="none"
          stroke={CANVAS_SELECT}
          strokeWidth={strokeW * 1.5}
          pointerEvents="none"
        />
      )}

      {/* Rubber-band preview line */}
      {rubberBandD && (
        <path
          d={rubberBandD}
          fill="none"
          stroke={CANVAS_PREVIEW}
          strokeWidth={strokeW}
          strokeDasharray={`${3 / zoom} ${3 / zoom}`}
          pointerEvents="none"
        />
      )}

      {/* Handles being dragged for current point */}
      {points.map((pt, idx) => (
        <g key={`pen_pt_${idx}`}>
          {pt.handleOut && (
            <>
              <line
                x1={pt.x}
                y1={pt.y}
                x2={pt.handleOut.x}
                y2={pt.handleOut.y}
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
              <circle
                cx={pt.handleOut.x}
                cy={pt.handleOut.y}
                r={controlR}
                fill={CANVAS_SELECT}
                stroke={CANVAS_ON_SELECT}
                strokeWidth={strokeW * 0.75}
              />
            </>
          )}
          {pt.handleIn && (
            <>
              <line
                x1={pt.x}
                y1={pt.y}
                x2={pt.handleIn.x}
                y2={pt.handleIn.y}
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
              <circle
                cx={pt.handleIn.x}
                cy={pt.handleIn.y}
                r={controlR}
                fill={CANVAS_SELECT}
                stroke={CANVAS_ON_SELECT}
                strokeWidth={strokeW * 0.75}
              />
            </>
          )}

          {/* Anchor point circle */}
          <circle
            cx={pt.x}
            cy={pt.y}
            r={anchorR}
            fill={CANVAS_ON_SELECT}
            stroke={CANVAS_SELECT}
            strokeWidth={strokeW * 1.2}
          />
        </g>
      ))}

      {/* Close path snap ring on point 0 */}
      {isHoveringFirst && points.length >= 2 && (
        <circle
          cx={points[0].x}
          cy={points[0].y}
          r={anchorR * 2.2}
          fill="none"
          stroke={CANVAS_SELECT}
          strokeWidth={strokeW * 1.5}
          pointerEvents="none"
        />
      )}
    </g>
  );
}
