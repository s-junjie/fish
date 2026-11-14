import type { RefObject } from "preact";
import type { DesignDocument, Effect, LayoutGuide, Paint, Stroke, StyleType, TextStyleDeclaration } from "../../core/dsl/types";
import { parseColorAlpha, composeColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { colorTokenColor } from "../../core/interactions/token-ops";
import { EffectRows } from "../EffectRows";
import { Plus } from "lucide-react";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";
import { NEW_SOLID, DEFAULT_STROKE_ROW } from "./style-draft-defaults";
import { ROW_CLASS } from "../row-style";
import { DraftPaintRows, DraftStrokeRows, DraftTextRows } from "./style-draft-rows";
import { GuideRows } from "./style-guide-rows";
import { EffectBanner, GuideBanner, PaintBanner, StrokeBanner, TextBanner } from "./style-preview-banners";

export interface StyleDrafts {
  paints: Paint[];
  strokes: Stroke[];
  /** A text style's declarations — type only, no ink (see `TextStyleDeclaration`). */
  textStyle: TextStyleDeclaration;
  effects: Effect[];
  /** A layout guide style's ruler, carried through the picker unchanged. */
  guides: LayoutGuide[];
}

interface StyleEditorViewProps {
  styleType: StyleType;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  name: string;
  description: string;
  drafts: StyleDrafts;
  setDrafts: (updater: (cur: StyleDrafts) => StyleDrafts, discrete?: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  editing: boolean;
  nameInputRef: RefObject<HTMLInputElement>;
  activePaintPicker: { index: number; anchor: HTMLElement } | null;
  setActivePaintPicker: (next: { index: number; anchor: HTMLElement } | null) => void;
  effectMenuAnchor: HTMLElement | null;
  setEffectMenuAnchor: (next: HTMLElement | null) => void;
  onNameChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  onSubmit: (e?: Event) => void;
  onCancel: () => void;
  /** The design-system tab edits in place; a banner preview is not part of that. */
  showPreview?: boolean;
  /** The undo stream for a token edit saved from the draft's token picker. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
}

/**
 * The editor half of the style picker: name and description, a banner preview,
 * and editable rows for whichever kind of style is being made.
 */
export function StyleEditorView({
  styleType,
  doc,
  docRef,
  name,
  description,
  drafts,
  setDrafts,
  onDragStart,
  onDragEnd,
  editing,
  nameInputRef,
  activePaintPicker,
  setActivePaintPicker,
  effectMenuAnchor,
  setEffectMenuAnchor,
  onNameChange,
  onDescriptionChange,
  onSubmit,
  onCancel,
  showPreview = true,
  onCommitSnapshot
}: StyleEditorViewProps) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col space-y-3">
      {showPreview && (
        <StyleBannerPreview styleType={styleType} drafts={drafts} doc={doc ?? docRef?.current} />
      )}

      <div className="space-y-2">
        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("styles.styleName")}</span>
          <input
            ref={nameInputRef}
            type="text"
            name="style-name"
            value={name}
            onInput={(e) => onNameChange((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing || (e as any).keyCode === 229) return;
              if (e.key === "Enter") onSubmit();
            }}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
          />
        </div>

        <div className={ROW_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-16 shrink-0`}>{t("styles.styleDescription")}</span>
          <input
            type="text"
            name="style-description"
            value={description}
            onInput={(e) => onDescriptionChange((e.target as HTMLInputElement).value)}
            placeholder={t("styles.styleDescriptionPlaceholder")}
            className={`flex-1 ${TEXT_FIELD_CLASS}`}
          />
        </div>
      </div>

      <div className="pt-2 border-t border-rule-strong flex items-center justify-between">
        <span className={SUB_LABEL_CLASS}>{t("styles.properties")}</span>
        {/* No plus on a text style: its properties are the fixed type set below
            (family, weight, size, line height, tracking), and the only thing a
            plus could have added was an effect — which a text style does not
            own. Effects belong to the layer, or to an effect style. */}
        {(styleType === "paint" || styleType === "stroke" || styleType === "effect" || styleType === "layoutGuide") && (
          <Button
            size="icon"
            type="button"
            data-style-add-layer={styleType}
            onClick={(e) => {
              if (styleType === "paint") {
                setDrafts((cur) => ({ ...cur, paints: [...cur.paints, { ...NEW_SOLID }] }));
              } else if (styleType === "stroke") {
                setDrafts((cur) => ({ ...cur, strokes: [...cur.strokes, { ...DEFAULT_STROKE_ROW }] }));
              } else if (styleType === "layoutGuide") {
                // A new row in a guide style is a column rule, the same default the
                // layer's own `+` uses.
                setDrafts((cur) => ({
                  ...cur,
                  guides: [...cur.guides, { kind: "columns", count: 5, align: "stretch", gutter: 20, margin: 0 }]
                }));
              } else {
                setEffectMenuAnchor(e.currentTarget as HTMLElement);
              }
            }}
            title={styleType === "paint" ? t("paint.addFill") : styleType === "stroke" ? t("paint.addStroke") : styleType === "layoutGuide" ? t("layoutGuide.add") : t("effects.add")}
            aria-label={styleType === "paint" ? t("paint.addFill") : styleType === "stroke" ? t("paint.addStroke") : styleType === "layoutGuide" ? t("layoutGuide.add") : t("effects.add")}
          >
            <Plus size={14} />
          </Button>
        )}
      </div>

      {styleType === "layoutGuide" && (
        <GuideRows
          guides={drafts.guides}
          doc={doc}
          onChange={(guides, discrete) => setDrafts((cur) => ({ ...cur, guides }), discrete)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      )}

      {styleType === "paint" && (
        <DraftPaintRows
          paints={drafts.paints}
          doc={doc}
          docRef={docRef}
          activePicker={activePaintPicker}
          onPick={setActivePaintPicker}
          onRemove={(idx) =>
            setDrafts((cur) => ({
              ...cur,
              paints: cur.paints.filter((_, i) => i !== idx)
            }))
          }
          onToggle={(idx, enabled) =>
            setDrafts((cur) => {
              const next = [...cur.paints];
              next[idx] = { ...next[idx], enabled };
              return { ...cur, paints: next };
            })
          }
          onAlpha={(idx, pct, discrete) =>
            setDrafts((cur) => {
              const p = cur.paints[idx];
              const next = [...cur.paints];
              if (p.type === "solid") {
                const nextSolid: Paint = {
                  ...p,
                  color: composeColorAlpha(parseColorAlpha(p.color).hex6, pct)
                };
                delete (nextSolid as any).opacity;
                next[idx] = nextSolid;
              } else {
                next[idx] = { ...p, opacity: pct / 100 };
              }
              return { ...cur, paints: next };
            }, discrete)
          }
          onHex={(idx, hex, alphaPct, discrete) =>
            setDrafts((cur) => {
              const next = [...cur.paints];
              const p = next[idx];
              if (p.type === "solid") {
                const nextSolid: Paint = { ...p, color: composeColorAlpha(hex, alphaPct) };
                delete (nextSolid as any).opacity;
                next[idx] = nextSolid;
              } else {
                next[idx] = p;
              }
              return { ...cur, paints: next };
            }, discrete)
          }
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onBindToken={(idx, token) => {
            if (docRef && !docRef.current.tokens?.some((t) => t.id === token.id)) {
              docRef.current = addTokenToDoc(docRef.current, token);
            }
            const activeDoc = docRef?.current ?? doc;
            const color = colorTokenColor(token, activeDoc?.activeTheme, activeDoc?.tokens);
            setDrafts((cur) => {
              const next = [...cur.paints];
              const p = next[idx];
              if (p && p.type === "solid") {
                next[idx] = { ...p, tokenId: token.id, color };
              }
              return { ...cur, paints: next };
            });
          }}
          onDetachToken={(idx) => {
            setDrafts((cur) => {
              const next = [...cur.paints];
              const p = next[idx];
              if (p && p.type === "solid" && p.tokenId) {
                const { tokenId: _, ...rest } = p;
                next[idx] = rest as Paint;
              }
              return { ...cur, paints: next };
            });
          }}
        />
      )}

      {styleType === "text" && (
        <DraftTextRows
          textStyle={drafts.textStyle}
          doc={doc}
          docRef={docRef}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(patch, discrete) =>
            setDrafts((cur) => ({ ...cur, textStyle: { ...cur.textStyle, ...patch } }), discrete)
          }
          onCommitTokenEdit={(nextDoc) => {
            if (docRef) {
              docRef.current = nextDoc;
              if (onCommitSnapshot) onCommitSnapshot(nextDoc);
            }
          }}
        />
      )}

      {styleType === "stroke" && (
        <DraftStrokeRows
          strokes={drafts.strokes}
          doc={doc}
          docRef={docRef}
          activePicker={activePaintPicker}
          onPick={setActivePaintPicker}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onRemove={(idx) =>
            setDrafts((cur) => ({
              ...cur,
              strokes: cur.strokes.filter((_, i) => i !== idx)
            }))
          }
          onToggle={(idx, enabled) =>
            setDrafts((cur) => {
              const next = [...cur.strokes];
              next[idx] = { ...next[idx], enabled };
              return { ...cur, strokes: next };
            })
          }
          onUpdateStroke={(idx, patch, discrete) =>
            setDrafts((cur) => {
              const next = [...cur.strokes];
              next[idx] = { ...next[idx], ...patch };
              return { ...cur, strokes: next };
            }, discrete)
          }
        />
      )}

      {styleType === "effect" && (
        <EffectRows
          effects={drafts.effects}
          doc={doc}
          docRef={docRef}
          onGestureStart={onDragStart}
          onGestureEnd={onDragEnd}
          onChange={(next, commit) => setDrafts((cur) => ({ ...cur, effects: next }), commit)}
          keepAtLeastOne
        />
      )}

      <div className="pt-2 border-t border-rule-strong flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="text"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="text"
        >
          {editing ? t("styles.editStyleAction") : t("styles.createStyleAction")}
        </Button>
      </div>
    </form>
  );
}

function StyleBannerPreview({
  styleType,
  drafts,
  doc
}: {
  styleType: StyleType;
  drafts: StyleDrafts;
  doc?: DesignDocument;
}) {
  if (styleType === "paint") return <PaintBanner paints={drafts.paints} doc={doc} />;
  if (styleType === "stroke") return <StrokeBanner strokes={drafts.strokes} />;
  if (styleType === "text") return <TextBanner style={drafts.textStyle} />;
  if (styleType === "layoutGuide") return <GuideBanner guides={drafts.guides} />;
  return <EffectBanner effects={drafts.effects} />;
}
