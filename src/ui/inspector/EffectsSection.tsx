import { useMemo, useState, useRef, useEffect } from "preact/hooks";
import { DesignElement, DesignDocument, EffectStyle, Paint } from "../../core/dsl/types";
import { parseColorAlpha, composeColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { Plus } from "lucide-react";
import { EffectRows, createEffect } from "../EffectRows";
import { elementTransform3d } from "../../core/geometry/transforms";
import { bindEffectStyle, unbindEffectStyle } from "../../core/interactions/style-ops";
import { StylePill } from "./StylePill";
import { renderStylePreview } from "./StylePreview";
import { deepEqual } from "../../core/deep-equal";
import { useStyleBindAction } from "../hooks/useStyleBindAction";
import { Section } from "./SectionHeader";
import { Button } from "../Button";
import { EffectTypeMenu } from "./EffectTypeMenu";

interface EffectsSectionProps {
  /** The whole selection: the list below is read across all of it. */
  elements: DesignElement[];
  primarySelected: DesignElement | null;
  docRef: { current: DesignDocument };
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function EffectsSection({
  elements,
  primarySelected,
  docRef,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd
}: EffectsSectionProps) {
  const [effectsMenuOpen, setEffectsMenuOpen] = useState(false);
  // Whether the selection's effect lists agree. Deep, not by length: two shadows
  // of the same blur in the same colour are the same list, and two shadows of
  // different colours are not.
  const effectsMixed = useMemo(() => {
    if (elements.length < 2) return false;
    const first = elements[0].effects ?? [];
    return elements.some((el) => !deepEqual(el.effects ?? [], first));
  }, [elements]);
  const [openEffectIdx, setOpenEffectIdx] = useState<number | null>(null);
  const menuTriggerRef = useRef<HTMLDivElement | null>(null);

  const boundStyle = (docRef.current.styles || []).find(
    (s) => s.id === primarySelected?.effectStyleId && s.styleType === "effect"
  ) as EffectStyle | undefined;
  // A bound style owns the whole list, like a paint style owns fills/strokes.
  // A text style does NOT: it is type only, so a text layer's shadow stays the
  // layer's and these rows always edit it.
  const styleManaged = !!boundStyle;

  const styleBind = useStyleBindAction<EffectStyle>({
    styleType: "effect",
    boundStyle,
    docRef,
    currentSelection: {
      type: "effect",
      elementId: primarySelected?.id,
      effects: primarySelected?.effects && primarySelected.effects.length > 0
        ? primarySelected.effects
        : [createEffect("drop-shadow")]
    },
    bind: (el, style) => bindEffectStyle(el, style),
    unbind: (el, bound) => unbindEffectStyle(el, bound),
    onMutate,
    onCommitSnapshot,
    triggerProps: { "data-effect-style-trigger": "1" }
  });

  // Below every hook: the picker above reads the selection, and an early return
  // above it would change the hook count between a text and a rect selection.
  if (!primarySelected) return null;

  return (
    <Section
      id="effects"
      title={t("properties.effects")}
      trailing={
        <>
          {styleBind.trigger}
          {styleBind.picker}
          <div ref={menuTriggerRef} className="relative">
            <Button
              size="icon"
              type="button"
              onClick={() => {
                setEffectsMenuOpen((prev) => {
                  const next = !prev;
                  if (next) setOpenEffectIdx(null);
                  return next;
                });
              }}
              disabled={styleManaged}
              title={styleManaged ? t("effects.managedByStyle") : t("effects.add")}
              aria-label={styleManaged ? t("effects.managedByStyle") : t("effects.add")}
            >
              <Plus size={13} />
            </Button>

            {effectsMenuOpen && !styleManaged && menuTriggerRef.current && (
              <EffectTypeMenu
                anchor={menuTriggerRef.current}
                onPick={(kind) => {
                  const next = createEffect(kind);
                  // A mixed selection is replaced outright, so the new effect is
                  // the whole list; otherwise it lands at the end.
                  const newIdx = effectsMixed ? 0 : primarySelected.effects?.length ?? 0;
                  onMutate(
                    (el) => {
                      const nextEffects = effectsMixed ? [next] : [...(el.effects || []), next];
                      // Like Figma, applying Glass to a layer whose solid fill is at
                      // 100% opacity sets the fill opacity to 20% so the glass
                      // effect is immediately visible rather than blocked by the opaque fill.
                      const nextFills =
                        kind === "liquid-glass" && Array.isArray(el.fills)
                          ? el.fills.map((f) => {
                              if (!f || f.type !== "solid") return f;
                              const parsed = parseColorAlpha(f.color);
                              const alphaPct =
                                typeof f.opacity === "number" ? Math.round(f.opacity * 100) : parsed.alphaPct;
                              if (alphaPct >= 99) {
                                const nextFill: Paint = {
                                  ...f,
                                  color: composeColorAlpha(parsed.hex6, 20)
                                };
                                delete (nextFill as any).opacity;
                                return nextFill;
                              }
                              return f;
                            })
                          : el.fills;
                      return { ...el, effects: nextEffects, ...(nextFills !== el.fills ? { fills: nextFills } : {}) };
                    },
                    true
                  );
                  setEffectsMenuOpen(false);
                  // A new effect opens its panel: every one of these is a
                  // setting the user has to fill in before it means anything.
                  setOpenEffectIdx(newIdx);
                }}
                onClose={() => setEffectsMenuOpen(false)}
                isText={primarySelected.type === "text"}
              />
            )}
          </div>
        </>
      }
    >

      {boundStyle && (
        <StylePill
          rowProps={{ "data-effect-style-pill": boundStyle.id }}
          styleName={boundStyle.name}
          preview={renderStylePreview(boundStyle, "w-4 h-4")}
          subtitle={boundStyle.effects.map((e) => e.type).join(", ")}
          selectTitle={t("styles.editStyle")}
          onSelect={styleBind.openFrom}
          onUnlink={() => onMutate((el) => unbindEffectStyle(el, boundStyle), true)}
          unlinkTitle={t("styles.detachStyle")}
        />
      )}

      {/* Figma's rule for a stack, same as Fill: the rows belong to ONE layer, so a
          selection whose effect lists differ gets one sentence and a `+` rather
          than the primary's list presented as the selection's. */}
      {effectsMixed && (
        <p data-effect-mixed="true" className="text-ui text-ink-muted">
          {t("properties.mixedContent")}
        </p>
      )}

      {!styleManaged && !effectsMixed && primarySelected.effects && primarySelected.effects.length > 0 && (
        <EffectRows
          effects={primarySelected.effects}
          doc={docRef.current}
          docRef={docRef}
          isText={primarySelected.type === "text"}
          tilted={Boolean(elementTransform3d(primarySelected))}
          box={{ w: primarySelected.width, h: primarySelected.height }}
          openIdx={openEffectIdx}
          onOpenIdxChange={setOpenEffectIdx}
          onChange={(next, commit) => onMutate((el) => ({ ...el, effects: next }), commit)}
          onCommit={() => onCommitSnapshot(docRef.current)}
          onCommitSnapshot={onCommitSnapshot}
          onGestureStart={onDragStart}
          onGestureEnd={onDragEnd}
        />
      )}
    </Section>
  );
}
