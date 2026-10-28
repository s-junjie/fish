import { useState, useRef, useEffect } from "preact/hooks";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { DesignDocument, PathElement, getActivePage } from "../../core/dsl/types";
import { findElementById } from "../../core/geometry/tree-ops";
import {
  parsePathData,
  serializePathData,
  moveAnchor,
  removeAnchor,
  getAnchorMirrorMode,
  EditablePath,
  Pt
} from "../../core/geometry/path-data";
import { applyPenTarget, resolvePenTarget, PenTarget } from "../../core/geometry/path-ops";
import { invert, matrixToSvg, transformPoint, transformVector, type Matrix2D } from "../../core/geometry/matrix";
import { NUDGE_STEP, NUDGE_STEP_SHIFT } from "../../core/interactions/alignment";
import type { PenMode } from "../../core/tools";
import { CANVAS_SELECT, CANVAS_COMPONENT, CANVAS_ON_SELECT, CANVAS_CORAL } from "./canvas-colors";

/** One degree of the 45° ladder a Shift-locked control handle snaps to. */
const RAY_STEP = Math.PI / 4;
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Which way each arrow key nudges, in canvas space.
 *
 * Canvas, not the path's own axes: the key names a direction on screen, and on a
 * turned path a step written straight into the local `x` would move the point
 * along the path's own axis instead — a different direction from the one the
 * user pressed.
 */
const NUDGE_KEYS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }
};

/**
 * Figma's Shift on a point drag: the point travels in a STRAIGHT line, so the
 * gesture keeps whichever axis it has already leaned on and drops the other.
 */
function lockToAxis(d: Pt): Pt {
  return Math.abs(d.x) >= Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
}

/** The pointer's point on the nearest 0/45/90 ray out of `origin`. */
function lockRayTo45(origin: Pt | undefined, p: Pt): Pt {
  if (!origin) return p;
  const vx = p.x - origin.x;
  const vy = p.y - origin.y;
  if (Math.hypot(vx, vy) < 1e-6) return p;
  const angle = Math.round(Math.atan2(vy, vx) / RAY_STEP) * RAY_STEP;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const reach = vx * ux + vy * uy;
  return { x: round1(origin.x + ux * reach), y: round1(origin.y + uy * reach) };
}

/**
 * The model as the DOCUMENT has it right now, parsed fresh.
 *
 * Anything that can MUTATE more than once per frame reads through this rather
 * than a captured model. This overlay's listeners live on the window and are
 * re-bound from effects, so a key can arrive before the render that follows the
 * previous edit — and the captured model is then one edit behind, so the press
 * replays the last edit instead of composing on it. Measured: a five-press arrow
 * burst at native key-repeat speed landed four steps. `useShortcuts` reads
 * `docRef` for the same reason. The pen's hover keeps the cached model: it is
 * advisory, runs per pointer event, and a click cannot repeat within a frame.
 */
function livePathModel(doc: DesignDocument, id: string): EditablePath | null {
  const el = findElementById(getActivePage(doc).children, id);
  return el && el.type === "path" ? parsePathData(el.d) : null;
}

/** The same selection `onToggleAnchor` is about to commit, for the drag to use. */
function toggleLocal(current: Set<number>, idx: number): Set<number> {
  const next = new Set(current);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  return next;
}

/**
 * Drops many anchors in one pass.
 *
 * Highest index first: `removeAnchor` renumbers everything above the anchor it
 * removes, so ascending order would shift the indices still queued behind it.
 *
 * It also stops once two anchors are left, because `removeAnchor` empties a path
 * rather than strip it below that — deleting a three-of-four selection would run
 * the last removal into that floor and wipe the shape instead of leaving a point.
 */
function removeAnchors(path: EditablePath, idxs: Set<number>): EditablePath {
  let next = path;
  for (const i of [...idxs].sort((a, b) => b - a)) {
    if (next.anchors.length <= 2) break;
    next = removeAnchor(next, i);
  }
  return next;
}

interface PathEditOverlayProps {
  pathElement: PathElement;
  zoom: number;
  pan: { x: number; y: number };
  /**
   * The path's own geometry coordinates → canvas: ancestors' turns, the path's
   * own turn and its `x`/`y` shift, in the order the renderer nests them.
   *
   * NOT an origin to add to `x`/`y`: `pathElement.d` stores anchors relative to
   * the layer's top-left, and the renderer draws them inside the frame's turned
   * `<g>`, so a translation-only chain names a point the artwork is not at the
   * moment any ancestor — or the path itself — is turned.
   */
  shapeMatrix: Matrix2D;
  /** The live document: see `livePathModel` for why an edit cannot read a prop. */
  docRef: { current: DesignDocument };
  selectedAnchorIdxs: Set<number>;
  onSelectOnlyAnchor: (idx: number) => void;
  onToggleAnchor: (idx: number) => void;
  /**
   * The pen's three modes, as set by the panel beside this overlay.
   *
   * `add` and `remove` are acted on HERE, not by the pen tool's own overlay: the
   * buttons live in the inspector, which only exists while a path is open for
   * editing, and the pen tool is not up while that is true. Routing the click to a
   * different overlay meant the buttons changed a value nothing was reading.
   */
  penMode: PenMode;
  /** Needed to turn a pointer position into this path's local coordinates. */
  containerRef: { current: HTMLDivElement | null };
  onCommitPath: (newD: string) => void;
  /** Drag lifecycle: start freezes the undo snapshot, change commits without
   * history, end folds the whole drag into exactly ONE undo step. */
  onDragStart?: () => void;
  onDragChange?: (newD: string) => void;
  /** Gesture ends at exit, so the whole edit session folds into one undo. */
  onExit: () => void;
}

export function PathEditOverlay({
  pathElement,
  zoom,
  pan,
  shapeMatrix,
  docRef,
  selectedAnchorIdxs,
  onSelectOnlyAnchor,
  onToggleAnchor,
  penMode,
  containerRef,
  onCommitPath,
  onDragStart,
  onDragChange,
  onExit
}: PathEditOverlayProps) {
  const [editable, setEditable] = useState<EditablePath | null>(() =>
    parsePathData(pathElement.d)
  );
  // The window listeners below outlive a render, so the pen's hover reads the
  // model from here. The KEYBOARD does not: a held arrow key repeats faster than
  // a render, and only a mutation that repeats needs the committed document —
  // see `livePathModel`.
  const editableRef = useRef(editable);
  editableRef.current = editable;

  /** Where the pointer is, and what the pen mode would do there. */
  const [penTarget, setPenTarget] = useState<PenTarget | null>(null);
  const penTargetRef = useRef<PenTarget | null>(null);
  penTargetRef.current = penTarget;
  const penModeRef = useRef(penMode);
  penModeRef.current = penMode;
  /** One handle radius: past it the cursor is not "on" the path. */
  const reach = 8 / zoom;

  /** The pointer in canvas space, given the container box it was read against. */
  const toCanvas = (e: { clientX: number; clientY: number }, rect: DOMRect): Pt => ({
    x: (e.clientX - rect.left - pan.x) / zoom,
    y: (e.clientY - rect.top - pan.y) / zoom
  });

  /**
   * Canvas space → this path's geometry coordinates, by the INVERSE of the very
   * matrix the overlay draws under. Subtracting `x`/`y` from a canvas point only
   * answers this while nothing is turned; once an ancestor or the path itself
   * rotates, the anchors are drawn somewhere those subtractions never name, and
   * every read of the pointer has to come back through the same matrix.
   */
  const localOf = (canvas: Pt): Pt | null => {
    const inv = invert(shapeMatrix);
    return inv ? transformPoint(inv, canvas) : null;
  };

  const toLocal = (e: { clientX: number; clientY: number }): Pt | null => {
    const container = containerRef.current;
    if (!container) return null;
    return localOf(toCanvas(e, container.getBoundingClientRect()));
  };

  const dragTarget = useRef<{
    type: "anchor" | "control";
    index: number;
    sub?: "ca" | "cb";
    /**
     * The press, in canvas space AND in the path's geometry coordinates, plus
     * the container box it was read against. Both frames are kept because a
     * constrained drag is decided on screen and written in geometry.
     */
    startCanvas: Pt;
    startLocal: Pt;
    containerRect: DOMRect;
    startPt?: Pt;
    startPts?: Map<number, Pt>;
    startPath?: EditablePath;
  } | null>(null);

  useEffect(() => {
    setEditable(parsePathData(pathElement.d));
  }, [pathElement.d]);

  /**
   * Keyboard navigation & deletion inside vector edit mode.
   *
   * The model comes from the document, not from a captured render value: a key
   * can arrive before the render that follows the previous one, so a captured
   * model replays the last edit instead of composing on it.
   */
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onExit();
      return;
    }

    const model = livePathModel(docRef.current, pathElement.id);
    if (!model) return;

    if (e.key === "Backspace" || e.key === "Delete") {
      if (selectedAnchorIdxs.size === 0) return;
      e.preventDefault();
      e.stopPropagation();
      onCommitPath(serializePathData(removeAnchors(model, selectedAnchorIdxs)));
      onSelectOnlyAnchor(-1);
      return;
    }

    // Arrow keys nudge the selected anchors — `useShortcuts` hands them to this
    // overlay and has no other reader, so without this they were dead keys.
    const nudge = NUDGE_KEYS[e.key];
    if (nudge && selectedAnchorIdxs.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      const inverse = invert(shapeMatrix);
      if (!inverse) return;
      const step = e.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
      const delta = transformVector(inverse, { x: nudge.x * step, y: nudge.y * step });
      let next = model;
      for (const i of [...selectedAnchorIdxs]) {
        const p = model.anchors[i];
        if (!p) continue;
        next = moveAnchor(next, i, round1(p.x + delta.x), round1(p.y + delta.y));
      }
      // One press, one history step: the same bargain `nudgeElements` makes.
      onCommitPath(serializePathData(next));
    }
  };
  useWindowKeydown(handleKeyDown, [selectedAnchorIdxs, shapeMatrix, pathElement.id, docRef, onExit, onCommitPath, onSelectOnlyAnchor]);

  // The pen modes act on the outline itself, so they listen on the window: the
  // path's own hit area is only its stroke band, and a click just inside a wide
  // shape's edge has to count too.
  useEffect(() => {
    if (penMode === "draw") {
      setPenTarget(null);
      return;
    }
    const onMove = (e: MouseEvent) => {
      const model = editableRef.current;
      const local = toLocal(e);
      if (!model || !local) return;
      setPenTarget(resolvePenTarget(model, local, reach));
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = penTargetRef.current;
      const model = editableRef.current;
      const mode = penModeRef.current;
      if (!target || !model || mode === "draw") return;

      if (mode === "add") {
        const isControlOrAnchor = (e.target as Element)?.closest?.("[data-anchor-index], [data-control-index]");
        if (isControlOrAnchor) return;
        if (target.anchorDist <= reach) {
          onSelectOnlyAnchor(target.anchorIdx);
          return;
        }
      }

      // Only claim the press when it would actually change something, so a click
      // far from the outline still reaches the canvas behind it.
      const next = applyPenTarget(target, mode, reach);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      onCommitPath(serializePathData(next));
      setEditable(next);
      setPenTarget(null);
      if (mode === "remove") onSelectOnlyAnchor(-1);
      else if (target.hit) {
        const hitSeg = target.model.segments[target.hit.segIdx];
        onSelectOnlyAnchor(hitSeg ? hitSeg.a + 1 : target.hit.segIdx + 1);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [penMode, zoom, pan.x, pan.y, shapeMatrix, onCommitPath, onSelectOnlyAnchor]);

  const handlePointerDownAnchor = (e: any, idx: number) => {
    if (e.button !== 0) return;
    // In remove mode a press means delete anchor, handled by onDown.
    if (penModeRef.current === "remove") return;
    e.stopPropagation();
    e.preventDefault();
    if (!editable) return;
    // Shift extends the selection and keeps the anchor under the cursor in it;
    // a plain click collapses to just that anchor if not already selected.
    if (e.shiftKey) onToggleAnchor(idx);
    else if (!selectedAnchorIdxs.has(idx)) onSelectOnlyAnchor(idx);

    const moving = e.shiftKey
      ? toggleLocal(selectedAnchorIdxs, idx)
      : (selectedAnchorIdxs.has(idx) ? selectedAnchorIdxs : new Set([idx]));

    const startPts = new Map<number, Pt>();
    for (const i of moving) {
      if (editable.anchors[i]) {
        startPts.set(i, { ...editable.anchors[i] });
      }
    }

    // The container box is read ONCE: reading it per move would force a layout
    // on every pointer event, and it cannot move while a button is held.
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    const startCanvas = toCanvas(e, containerRect);
    const startLocal = localOf(startCanvas);
    if (!startLocal) return;

    dragTarget.current = {
      type: "anchor",
      index: idx,
      startCanvas,
      startLocal,
      containerRect,
      startPts,
      startPath: editable
    };

    document.body.style.cursor = "default";
    onDragStart?.();

    const handlePointerMove = (moveEv: PointerEvent) => {
      const drag = dragTarget.current;
      if (!drag || !drag.startPts) return;
      const raw = toCanvas(moveEv, drag.containerRect);
      // A delta measured in canvas space has to come back through the matrix,
      // or a turned path's anchors slide along the wrong axis. Shift decides on
      // screen and the constraint is then carried into geometry with it, so a
      // locked drag travels visually straight on a path at any angle.
      const moved = { x: raw.x - drag.startCanvas.x, y: raw.y - drag.startCanvas.y };
      const canvasDelta = moveEv.shiftKey ? lockToAxis(moved) : moved;
      const now = localOf({ x: drag.startCanvas.x + canvasDelta.x, y: drag.startCanvas.y + canvasDelta.y });
      if (!now) return;
      const dx = now.x - drag.startLocal.x;
      const dy = now.y - drag.startLocal.y;

      let next = drag.startPath ?? editable;
      for (const [i, pt] of drag.startPts) {
        next = moveAnchor(next, i, round1(pt.x + dx), round1(pt.y + dy));
      }
      setEditable(next);
      onDragChange?.(serializePathData(next));
    };

    const handlePointerUp = () => {
      document.body.style.cursor = "";
      dragTarget.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handlePointerDownControl = (e: any, segIdx: number, sub: "ca" | "cb") => {
    if (e.button !== 0) return;
    if (penModeRef.current === "remove") return;
    e.stopPropagation();
    e.preventDefault();
    if (!editable) return;
    const seg = editable.segments[segIdx];
    if (seg.kind !== "cubic") return;
    const pt = sub === "ca" ? seg.ca : seg.cb;

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    const startCanvas = toCanvas(e, containerRect);
    const startLocal = localOf(startCanvas);
    if (!startLocal) return;

    dragTarget.current = {
      type: "control",
      index: segIdx,
      sub,
      startCanvas,
      startLocal,
      containerRect,
      startPt: { ...pt }
    };

    document.body.style.cursor = "default";
    onDragStart?.();

    const handlePointerMove = (moveEv: PointerEvent) => {
      const drag = dragTarget.current;
      if (!drag || !drag.startPt) return;
      const now = localOf(toCanvas(moveEv, drag.containerRect));
      if (!now) return;
      const dx = now.x - drag.startLocal.x;
      const dy = now.y - drag.startLocal.y;
      let newX = round1(drag.startPt.x + dx);
      let newY = round1(drag.startPt.y + dy);

      // Shift locks the handle to a 0/45/90 ray out of its anchor — the pen's
      // own handle gesture, on the same ladder. Measured in geometry, which is
      // the space the handle is stored in.
      const anchorIdx = sub === "ca" ? seg.a : seg.b;
      if (moveEv.shiftKey) {
        const locked = lockRayTo45(editable.anchors[anchorIdx], { x: newX, y: newY });
        newX = locked.x;
        newY = locked.y;
      }

      const nextSegments = editable.segments.map((s, i) => {
        if (i === segIdx && s.kind === "cubic") {
          return sub === "ca"
            ? { ...s, ca: { x: newX, y: newY } }
            : { ...s, cb: { x: newX, y: newY } };
        }
        return s;
      });

      // If the anchor has mirroring enabled, update opposite handle
      const P = editable.anchors[anchorIdx];
      const mode = getAnchorMirrorMode(editable, anchorIdx);

      if (P && (mode === "all" || mode === "angle")) {
        const vx = newX - P.x;
        const vy = newY - P.y;
        const hLen = Math.hypot(vx, vy) || 1;

        if (sub === "ca") {
          // Opposite handle is cb on segment ending at anchorIdx
          const inSegIdx = nextSegments.findIndex((s, idx) => idx !== segIdx && s.b === anchorIdx && s.kind === "cubic");
          if (inSegIdx !== -1) {
            const inSeg = nextSegments[inSegIdx] as any;
            const len = mode === "all" ? hLen : (Math.hypot(inSeg.cb.x - P.x, inSeg.cb.y - P.y) || hLen);
            nextSegments[inSegIdx] = {
              ...inSeg,
              cb: { x: Math.round((P.x - (vx / hLen) * len) * 10) / 10, y: Math.round((P.y - (vy / hLen) * len) * 10) / 10 }
            };
          }
        } else {
          // Opposite handle is ca on segment starting at anchorIdx
          const outSegIdx = nextSegments.findIndex((s, idx) => idx !== segIdx && s.a === anchorIdx && s.kind === "cubic");
          if (outSegIdx !== -1) {
            const outSeg = nextSegments[outSegIdx] as any;
            const len = mode === "all" ? hLen : (Math.hypot(outSeg.ca.x - P.x, outSeg.ca.y - P.y) || hLen);
            nextSegments[outSegIdx] = {
              ...outSeg,
              ca: { x: Math.round((P.x - (vx / hLen) * len) * 10) / 10, y: Math.round((P.y - (vy / hLen) * len) * 10) / 10 }
            };
          }
        }
      }

      const next = { ...editable, segments: nextSegments };
      setEditable(next);
      onDragChange?.(serializePathData(next));
    };

    const handlePointerUp = () => {
      document.body.style.cursor = "";
      dragTarget.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  if (!editable) return null;

  // Refined Figma handle dimensions
  const anchorR = 3.5 / zoom;
  const controlR = 2.5 / zoom;
  const strokeW = 1 / zoom;
  const hitR = 8 / zoom;

  const penActive = penMode !== "draw";
  /** What a click would take away, so remove mode reads as armed or not. */
  const doomedIdx = penMode === "remove" && penTarget && penTarget.anchorDist <= reach ? penTarget.anchorIdx : -1;
  /** The spot add mode would insert at. */
  const addMark =
    penMode === "add" && penTarget && penTarget.hit && penTarget.anchorDist > reach ? penTarget.hit.point : null;

  return (
    <g
      data-path-edit="true"
      // The same composition the renderer performs — every ancestor's turn, this
      // path's own turn about its pivot, then its `x`/`y` — so the handles land
      // on the artwork rather than on the origin-plus-`x`/`y` point that only
      // equals it while nothing is turned.
      transform={matrixToSvg(shapeMatrix)}
      className="select-none"
    >
      {/* In a pen mode the outline is the target, so it is drawn: without it
          there is nothing telling the pointer what it is about to hit. */}
      {penActive && (
        <path
          d={pathElement.d}
          fill="none"
          stroke={CANVAS_SELECT}
          strokeOpacity={0.45}
          strokeWidth={strokeW * 2}
          pointerEvents="none"
        />
      )}

      {/* Control Handles (Lines and circles) for Bézier segments */}
      {editable.segments.map((seg, sIdx) => {
        if (seg.kind === "cubic") {
          const a = editable.anchors[seg.a];
          const b = editable.anchors[seg.b];
          if (!a || !b) return null;

          return (
            <g key={`cubic_ctrl_${sIdx}`}>
              {/* Handle Line A */}
              <line
                x1={a.x}
                y1={a.y}
                x2={seg.ca.x}
                y2={seg.ca.y}
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
              {/* Handle Circle A with transparent hit circle */}
              <circle
                data-control-index={sIdx}
                data-control-side="ca"
                cx={seg.ca.x}
                cy={seg.ca.y}
                r={hitR}
                fill="transparent"
                style={{ cursor: "default" }}
                onPointerDown={(e) => handlePointerDownControl(e, sIdx, "ca")}
              />
              <circle
                cx={seg.ca.x}
                cy={seg.ca.y}
                r={controlR}
                fill={CANVAS_SELECT}
                stroke={CANVAS_ON_SELECT}
                strokeWidth={strokeW * 0.75}
                pointerEvents="none"
              />

              {/* Handle Line B */}
              <line
                x1={b.x}
                y1={b.y}
                x2={seg.cb.x}
                y2={seg.cb.y}
                stroke={CANVAS_SELECT}
                strokeWidth={strokeW}
              />
              {/* Handle Circle B with transparent hit circle */}
              <circle
                data-control-index={sIdx}
                data-control-side="cb"
                cx={seg.cb.x}
                cy={seg.cb.y}
                r={hitR}
                fill="transparent"
                style={{ cursor: "default" }}
                onPointerDown={(e) => handlePointerDownControl(e, sIdx, "cb")}
              />
              <circle
                cx={seg.cb.x}
                cy={seg.cb.y}
                r={controlR}
                fill={CANVAS_SELECT}
                stroke={CANVAS_ON_SELECT}
                strokeWidth={strokeW * 0.75}
                pointerEvents="none"
              />
            </g>
          );
        }
        return null;
      })}

      {addMark && (
        <g pointerEvents="none">
          <line
            x1={addMark.x - 4 / zoom}
            y1={addMark.y}
            x2={addMark.x + 4 / zoom}
            y2={addMark.y}
            stroke={CANVAS_SELECT}
            strokeWidth={strokeW * 1.5}
          />
          <line
            x1={addMark.x}
            y1={addMark.y - 4 / zoom}
            x2={addMark.x}
            y2={addMark.y + 4 / zoom}
            stroke={CANVAS_SELECT}
            strokeWidth={strokeW * 1.5}
          />
        </g>
      )}

      {/* Anchor Points */}
      {editable.anchors.map((p, aIdx) => {
        const isSelected = selectedAnchorIdxs.has(aIdx);
        return (
          <g key={`anchor_${aIdx}`}>
            {/* Transparent comfortable hit zone */}
            <circle
              data-anchor-index={aIdx}
              cx={p.x}
              cy={p.y}
              r={hitR}
              fill="transparent"
              style={{ cursor: "default" }}
              onPointerDown={(e) => handlePointerDownAnchor(e, aIdx)}
            />
            {/* Visual anchor point */}
            <circle
              cx={p.x}
              cy={p.y}
              r={aIdx === doomedIdx ? anchorR * 1.3 : anchorR}
              fill={aIdx === doomedIdx ? CANVAS_CORAL : isSelected ? CANVAS_SELECT : CANVAS_ON_SELECT}
              stroke={aIdx === doomedIdx ? CANVAS_ON_SELECT : isSelected ? CANVAS_ON_SELECT : CANVAS_SELECT}
              strokeWidth={strokeW * 1.2}
              pointerEvents="none"
            />
          </g>
        );
      })}
    </g>
  );
}

