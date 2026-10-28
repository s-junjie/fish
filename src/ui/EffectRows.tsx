import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DesignDocument, Effect, EdgeProfile, TearForm } from "../core/dsl/types";
import { moveStackRow, stackRows } from "../core/dsl/paint-stack";
import { LIQUID_GLASS_DEFAULTS } from "../core/dsl/liquid-glass";
import { EDGE_DEFAULT } from "../core/geometry/edge";
import { EffectPanel } from "./inspector/EffectPanel";
import { PAINT_ROW_CLASS, PAINT_ROW_RULE_IDLE, PAINT_ROW_RULE_OPEN } from "./inspector/paint-row-style";
import { t } from "../i18n";
import { Eye, EyeOff, GripVertical, Minus, AlertTriangle } from "lucide-react";
import { Button } from "./Button";
import { usePaintStackDrag } from "./hooks/usePaintStackDrag";
import { PaintDropIndicator } from "./inspector/PaintDropIndicator";
import { PaintDragGhost } from "./PaintDragGhost";

export type EffectKind = Effect["type"];

export const EFFECT_KINDS: EffectKind[] = [
  "drop-shadow",
  "inner-shadow",
  "layer-blur",
  "backdrop-blur",
  "liquid-glass",
  "tear"
];

/**
 * One name per effect, on every layer.
 *
 * A drop shadow on a text element paints through the glyphs (a CSS
 * `text-shadow`) instead of around the box, but that is the renderer's business
 * — the designer asked for a drop shadow and got one, so the row says so. The
 * old "Text Shadow" label named the implementation and implied a second effect
 * that does not exist.
 */
export function effectLabel(type: EffectKind, profile?: EdgeProfile, form?: TearForm): string {
  if (type === "liquid-glass") {
    return t("effects.glass");
  }
  // A row named only "Edge" would make five different effects indistinguishable
  // in the stack, so the break's own name rides along — and a closed break says
  // which side of it survives, because a hole and a scrap of the same contour
  // are opposite pictures.
  if (type === "tear" && profile) {
    // The row names the FORM, not the family: a hole is not an edge, and the
    // panel above already says "Break | Hole | Scrap", so a row reading "Edge ·
    // Torn" beside a form reading "Hole" would be two vocabularies for one thing.
    return `${t(`tear.form.${form ?? "edge"}`)} · ${t(`tear.profile.${profile}`)}`;
  }
  return t(`effects.${type.replace("-", "")}`);
}

export function createEffect(type: EffectKind): Effect {
  switch (type) {
    case "drop-shadow":
    case "inner-shadow":
      return { type, color: "#00000080", offset: { x: 0, y: 4 }, blur: 8, enabled: true };
    case "layer-blur":
      return { type, blur: 8, enabled: true };
    case "backdrop-blur":
      return { type, blur: 16, enabled: true };
    case "liquid-glass":
      // Figma's seven parameters, at the calibrated defaults. The defaults live in
      // `core/dsl/liquid-glass.ts` so the inspector and the bake cannot drift;
      // this is only the effect object that carries them.
      return { type: "liquid-glass", ...LIQUID_GLASS_DEFAULTS, enabled: true };
    case "tear":
      // The seed is random ONCE, here, because two layers breaking alike is the
      // defect the user is guarding against. It is then WRITTEN DOWN — the
      // normalizer refuses to roll dice, so this same break re-renders on every
      // load, in every export, on every machine. Fiber starts at 0: a clean
      // cut, until the fibres are asked for.
      return {
        type,
        profile: "torn",
        side: "right",
        scale: EDGE_DEFAULT.scale,
        roughness: 0.6,
        fiber: 0,
        seed: Math.floor(Math.random() * 0x7fffffff),
        enabled: true
      };
  }
}

/** The two that carry a colour and an offset; the others carry only a blur. */
type OffsetEffect = Extract<Effect, { type: "drop-shadow" | "inner-shadow" }>;

function isOffsetEffect(ef: Effect): ef is OffsetEffect {
  return ef.type === "drop-shadow" || ef.type === "inner-shadow";
}

/** Numbers that say WHAT this effect is, at a glance. */
function effectSummary(ef: Effect): string {
  if (ef.type === "liquid-glass") return "";
  if (ef.type === "tear") return "";
  const blur = Math.round(ef.blur ?? 0);
  if (isOffsetEffect(ef)) {
    const spread = "spread" in ef && ef.spread ? ` ${Math.round(ef.spread)}` : "";
    return `${Math.round(ef.offset.x)} ${Math.round(ef.offset.y)} ${blur}${spread}`;
  }
  return `${blur}`;
}
const EFFECT_MARK = "relative h-3.5 w-3.5 flex-none shrink-0 ring-1 ring-inset ring-swatch-ring";

/**
 * Every kind draws a CASTER first — a neutral disc — and the effect then acts on
 * it. That is the fix for "the drop-shadow icon is unreadable": the mark used to
 * be a `rgba(0,0,0,.5)` blob, i.e. a shadow with no object, on a dark row, which
 * is a black circle on a black row. Drop and inner are now the SAME disc differing
 * only in whether the shadow falls outside or inside it — the one thing that
 * separates them, and the thing the mark has to say.
 *
 * Composed from the theme's `ink-dim` channels rather than a literal, so a theme
 * change reaches the swatch too.
 */
const CASTER = "rgb(var(--fish-ink-dim) / 0.55)";

/**
 * One silhouette per kind of break, as the row's mark.
 *
 * The row's whole job is to say at a glance what this effect does, and every
 * profile is a different shape — a disc with differently shaped bites along its
 * far side.
 */
const EDGE_MARKS: Record<EdgeProfile, string> = {
  torn: "polygon(0 0, 68% 0, 56% 14%, 72% 30%, 52% 46%, 74% 62%, 58% 78%, 70% 92%, 62% 100%, 0 100%)",
  scallop:
    "polygon(0 0, 64% 0, 68.7% 6.25%, 72% 12.5%, 68.7% 18.75%, 64% 25%, 68.7% 31.25%, 72% 37.5%, 68.7% 43.75%, 64% 50%, 68.7% 56.25%, 72% 62.5%, 68.7% 68.75%, 64% 75%, 68.7% 81.25%, 72% 87.5%, 68.7% 93.75%, 64% 100%, 0 100%)",
  zigzag:
    "polygon(0 0, 76% 0, 60% 10%, 76% 20%, 60% 30%, 76% 40%, 60% 50%, 76% 60%, 60% 70%, 76% 80%, 60% 90%, 76% 100%, 0 100%)"
};

function effectPreviewStyle(ef: Effect): Record<string, string> {
  if (isOffsetEffect(ef)) {
    const spreadPx = "spread" in ef && ef.spread ? ` ${(ef.spread ?? 0) / 3}px` : "";
    const shadow = `0 ${(ef.offset?.y ?? 0) / 3}px ${(ef.blur ?? 0) / 3}px${spreadPx} ${ef.color || "rgba(0,0,0,.5)"}`;
    return {
      background: CASTER,
      borderRadius: "50%",
      // Drop casts OUTSIDE the disc, inner INSIDE it — the one thing that
      // separates the two, and the whole of what the mark has to say.
      boxShadow: ef.type === "inner-shadow" ? `inset ${shadow}` : shadow
    };
  }
  if (ef.type === "liquid-glass") {
    return {
      background: "linear-gradient(135deg, rgba(255,255,255,.35), rgba(255,255,255,.06))",
      borderRadius: "50%"
    };
  }
  if (ef.type === "tear") {
    return {
      background: CASTER,
      clipPath: EDGE_MARKS[ef.profile]
    };
  }
  return {
    background: CASTER,
    borderRadius: "50%",
    filter: `blur(${Math.min(4, Math.max(1, (ef.blur ?? 0) / 6))}px)`
  };
}

interface EffectRowsProps {
  effects: Effect[];
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  /** `commit` true means a discrete edit (one undo entry), not a step of a drag. */
  onChange: (next: Effect[], commit?: boolean) => void;
  onCommit?: () => void;
  /** The undo stream for a token edit saved from the effect token picker. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  /** A style must keep one layer; an element's own effect list may be emptied. */
  keepAtLeastOne?: boolean;
  isText?: boolean;
  /** The layer carries a perspective tilt, where a torn edge is left undrawn. */
  tilted?: boolean;
  openIdx?: number | null;
  onOpenIdxChange?: (idx: number | null) => void;
  /** The layer's box, for the fields whose default is a length of it. */
  box?: { w: number; h: number };
}

export function EffectRows({
  effects,
  doc,
  docRef,
  onChange,
  onCommit,
  onCommitSnapshot,
  onGestureStart,
  onGestureEnd,
  keepAtLeastOne = false,
  isText = false,
  tilted = false,
  openIdx: controlledOpenIdx,
  onOpenIdxChange,
  box
}: EffectRowsProps) {
  const [internalOpenIdx, setInternalOpenIdx] = useState<number | null>(null);
  const openIdx = controlledOpenIdx !== undefined ? controlledOpenIdx : internalOpenIdx;
  const setOpenIdx = onOpenIdxChange ?? setInternalOpenIdx;
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});

  /**
   * A panel opened on a row that was created by the same commit has no node to
   * anchor to while rendering it — refs attach after render, before effects. So
   * the row is read back here, and the panel waits one commit for it.
   */
  const [panelAnchor, setPanelAnchor] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = openIdx === null ? null : rowRefs.current[openIdx] ?? null;
    setPanelAnchor((cur) => (cur === el ? cur : el));
  }, [openIdx, effects.length]);

  const listRef = useRef<HTMLDivElement | null>(null);

  const replace = (index: number, next: Effect, commit?: boolean) =>
    onChange(effects.map((e, i) => (i === index ? next : e)), commit);

  const rows = stackRows(effects);

  const { dragUi, beginDrag } = usePaintStackDrag({
    listRef,
    rowAttr: "data-effect-row",
    ghostFor: (uiPos) => {
      const ef = rows[uiPos]?.item;
      if (!ef) return { swatch: CASTER, label: "" };
      let swatch = CASTER;
      if (ef.type === "liquid-glass") {
        swatch = "linear-gradient(135deg, rgba(255,255,255,.35), rgba(255,255,255,.06))";
      } else if (isOffsetEffect(ef) && ef.color) {
        swatch = ef.color;
      }
      return {
        swatch,
        label: effectLabel(ef.type, ef.type === "tear" ? ef.profile : undefined, ef.type === "tear" ? ef.form : undefined)
      };
    },
    onCommit: (fromUi, insertBeforeUi) => {
      onGestureEnd?.();
      const next = moveStackRow(effects, fromUi, insertBeforeUi);
      if (!next.some((e, i) => e !== effects[i])) return;
      if (openIdx !== null) setOpenIdx(null);
      onChange(next, true);
    }
  });

  return (
    <div ref={listRef} data-paint-stack="effect" className="space-y-1.5">
      {rows.map(({ item: ef, index: idx }, uiPos) => {
        const isOpen = openIdx === idx;
        const disabled = ef.enabled === false;
        // The renderer drops the break on a tilted layer (its clip is a
        // local-space flat silhouette), so the row says so instead of pretending.
        const edgeOnTilt = tilted && ef.type === "tear";
        return (
          <div key={idx} className="relative">
            <div
              ref={(el) => {
                rowRefs.current[idx] = el;
              }}
              data-effect-row={idx}
              onClick={() => setOpenIdx(isOpen ? null : idx)}
              title={edgeOnTilt ? t("tear.tiltDisabled") : undefined}
              className={`${PAINT_ROW_CLASS} ${isOpen ? PAINT_ROW_RULE_OPEN : PAINT_ROW_RULE_IDLE} cursor-pointer ${disabled ? "opacity-50" : ""} ${dragUi?.fromUi === uiPos ? "opacity-40" : ""
                }`.trim()}
            >
              <PaintDropIndicator
                active={!!dragUi && (dragUi.slot === uiPos || (uiPos === rows.length - 1 && dragUi.slot === rows.length))}
                isLast={uiPos === rows.length - 1}
              />

              {rows.length > 1 && (
                <button
                  type="button"
                  data-effect-handle={idx}
                  title={t("paint.reorder")}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onGestureStart?.();
                    beginDrag(uiPos, e);
                  }}
                  className="text-ink-muted hover:text-ink p-0 shrink-0 cursor-grab active:cursor-grabbing touch-none"
                >
                  <GripVertical size={12} />
                </button>
              )}

              <span className={`${EFFECT_MARK} ${edgeOnTilt ? "opacity-50" : ""}`} style={effectPreviewStyle(ef)} />
              <span className={`flex-1 min-w-0 truncate text-left text-code text-ink-dim ${edgeOnTilt ? "opacity-50" : ""}`}>
                {effectLabel(ef.type, ef.type === "tear" ? ef.profile : undefined, ef.type === "tear" ? ef.form : undefined)}
              </span>
              <span className={`shrink-0 text-meta text-ink-muted tabular-nums ${edgeOnTilt ? "opacity-50" : ""}`}>{effectSummary(ef)}</span>

              {edgeOnTilt && (
                <span className="flex-none text-measure-coral" title={t("tear.tiltDisabled")}>
                  <AlertTriangle size={12} />
                </span>
              )}

              <Button
                size="icon"
                type="button"
                onClick={(e) => {
                  // The row opens the parameter panel; the two actions must not.
                  e.stopPropagation();
                  replace(idx, { ...ef, enabled: disabled } as Effect, true);
                }}
                title={disabled ? t("effects.enable") : t("effects.disable")}
                aria-label={disabled ? t("effects.enable") : t("effects.disable")}
              >
                {disabled ? <EyeOff size={12} /> : <Eye size={12} />}
              </Button>
              {(!keepAtLeastOne || effects.length > 1) && (
                <Button
                  variant="danger"
                  size="icon"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openIdx === idx) setOpenIdx(null);
                    onChange(effects.filter((_, i) => i !== idx), true);
                  }}
                  title={t("effects.remove")}
                  aria-label={t("effects.remove")}
                >
                  <Minus size={12} />
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {openIdx !== null && effects[openIdx] && (
        <EffectPanel
          effect={effects[openIdx]}
          doc={doc}
          docRef={docRef}
          anchor={panelAnchor}
          onClose={() => setOpenIdx(null)}
          onChange={(next, commit) => replace(openIdx, next, commit)}
          onCommit={onCommit}
          onCommitSnapshot={onCommitSnapshot}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
          isText={isText}
          box={box}
        />
      )}

      {dragUi && (
        <PaintDragGhost
          x={dragUi.x}
          y={dragUi.y}
          width={dragUi.width}
          swatch={dragUi.swatch}
          label={dragUi.label}
          mono={false}
        />
      )}
    </div>
  );
}
