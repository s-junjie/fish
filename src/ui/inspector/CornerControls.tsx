import { DesignDocument, DesignElement, hasCornerSmoothing, isBorderRadiusHolder } from "../../core/dsl/types";
import { parseCornerRadii } from "../../core/geometry/rounded-box";
import { ScrubInput } from "../ScrubInput";
import { resolveAcross } from "./mixed";
import { t } from "../../i18n";
import { SquareRoundCorner, Scan } from "lucide-react";
import { useState } from "preact/hooks";
import {
  bindNumberTokenToElement,
  findNumberToken,
  unbindNumberTokenFromElement
} from "../../core/interactions/number-token-ops";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { NumberTokenPicker } from "./NumberTokenPicker";
import { findMasterComponent } from "../../core/interactions/component-inventory";

interface CornerControlsProps {
  /** The whole selection. Every write goes through `onMutate`, which applies to all
   *  of them — so a field bound to one of them while editing five is a lie. */
  elements: DesignElement[];
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  is4Corners: boolean;
  onToggle4Corners: (val: boolean) => void;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  /** The undo stream for a token edit saved from its token picker. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/** Figma's `iOS` preset, in the same 0..1 the field stores. */
const IOS_SQUIRCLE = 0.6;

/**
 * Which way `SquareRoundCorner` has to turn to name a corner.
 *
 * Lucide draws the rounded-ctl corner at the TOP-RIGHT, so that is the unrotated one
 * and the rest follow clockwise. The glyph alone carries the field — in the 2×2
 * grid the position does the naming, so the fields stay icon-only.
 */
const CORNERS = {
  topLeft: { rotation: "-rotate-90", slot: 0 },
  topRight: { rotation: "rotate-0", slot: 1 },
  bottomRight: { rotation: "rotate-90", slot: 2 },
  bottomLeft: { rotation: "rotate-180", slot: 3 }
} as const;

/** The order the four fields are DRAWN in: reading order of the 2×2 grid. It is
 *  not the storage order — `parseCornerRadii` is [TL, TR, BR, BL], CSS's
 *  clockwise convention — so the two are kept apart on purpose. */
const CORNER_ORDER = ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const;

export const CORNER_TOKEN_PROPS = {
  topLeft: "topLeftRadius",
  topRight: "topRightRadius",
  bottomRight: "bottomRightRadius",
  bottomLeft: "bottomLeftRadius"
} as const;

export const CORNER_TOKEN_ALIASES = {
  topLeft: "borderTopLeftRadius",
  topRight: "borderTopRightRadius",
  bottomRight: "borderBottomRightRadius",
  bottomLeft: "borderBottomLeftRadius"
} as const;

const CORNER_TITLES = {
  topLeft: "properties.cornerTopLeft",
  topRight: "properties.cornerTopRight",
  bottomLeft: "properties.cornerBottomLeft",
  bottomRight: "properties.cornerBottomRight"
} as const;

function cornerLabel(corner: keyof typeof CORNERS) {
  return <SquareRoundCorner size={11} className={`shrink-0 ${CORNERS[corner].rotation}`} />;
}

interface IndependentCornersToggleProps {
  elements: DesignElement[];
  is4Corners: boolean;
  onToggle4Corners: (val: boolean) => void;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
}

/**
 * The independent-corners switch, drawn in the trailing slot of the APPEARANCE
 * header — the header the corner fields live under. Only offered when every
 * selected layer stores `borderRadius`: polygon and star keep a single
 * `cornerRadius` with nothing to split.
 */
export function IndependentCornersToggle({
  elements,
  is4Corners,
  onToggle4Corners,
  onMutate
}: IndependentCornersToggleProps) {
  const selected = elements[0];
  if (!selected || !elements.every(isBorderRadiusHolder)) return null;

  return (
    <button
      type="button"
      data-corner-independent="true"
      aria-pressed={is4Corners}
      onClick={() => {
        const current = isBorderRadiusHolder(selected) ? selected.borderRadius : undefined;
        if (is4Corners) {
          const radii = parseCornerRadii(current);
          onToggle4Corners(false);
          onMutate((el) => {
            if (!isBorderRadiusHolder(el)) return el;
            const r = parseCornerRadii(el.borderRadius);
            const nextEl: any = { ...el, borderRadius: r[0] ?? 0 };
            if (el.tokenBindings) {
              const b = el.tokenBindings;
              const tl = b.topLeftRadius ?? b.borderTopLeftRadius;
              const tr = b.topRightRadius ?? b.borderTopRightRadius;
              const br = b.bottomRightRadius ?? b.borderBottomRightRadius;
              const bl = b.bottomLeftRadius ?? b.borderBottomLeftRadius;
              const nextBindings = { ...b };
              delete nextBindings.topLeftRadius;
              delete nextBindings.borderTopLeftRadius;
              delete nextBindings.topRightRadius;
              delete nextBindings.borderTopRightRadius;
              delete nextBindings.bottomRightRadius;
              delete nextBindings.borderBottomRightRadius;
              delete nextBindings.bottomLeftRadius;
              delete nextBindings.borderBottomLeftRadius;
              if (tl && tl === tr && tl === br && tl === bl) {
                nextBindings.borderRadius = tl;
              }
              nextEl.tokenBindings = Object.keys(nextBindings).length > 0 ? nextBindings : undefined;
            }
            return nextEl;
          }, true);
        } else {
          onToggle4Corners(true);
          onMutate((el) => {
            if (!isBorderRadiusHolder(el)) return el;
            const r = parseCornerRadii(el.borderRadius);
            const nextEl: any = { ...el, borderRadius: [r[0], r[1], r[2], r[3]] };
            const boundId = el.tokenBindings?.borderRadius;
            if (boundId) {
              const nextBindings = { ...el.tokenBindings };
              delete nextBindings.borderRadius;
              nextBindings.topLeftRadius = boundId;
              nextBindings.topRightRadius = boundId;
              nextBindings.bottomRightRadius = boundId;
              nextBindings.bottomLeftRadius = boundId;
              nextEl.tokenBindings = nextBindings;
            }
            return nextEl;
          }, true);
        }
      }}
      /* No box of its own. A bordered, filled button in a header reads
         as a second control competing with the label, and the header's
         other trailing action ("resize to fit") is a bare glyph — two
         headers, two shapes, same slot. `aria-pressed` plus the brand
         glyph carries the on/off state; the chrome does not. */
      className={`p-1 rounded-ctl transition-colors ${
        is4Corners ? "text-brand bg-brand-wash" : "text-ink-dim hover:text-ink hover:bg-raised"
      }`}
      title={is4Corners ? t("properties.singleCornerRadius") : t("properties.independentCorners")}
      aria-label={is4Corners ? t("properties.singleCornerRadius") : t("properties.independentCorners")}
    >
      <Scan size={13} />
    </button>
  );
}

/**
 * Every corner control, in one section: Figma's two controls plus the
 * Independent Corners affordance that belongs with the radius.
 *
 * - **radius** (px) — how DEEP each corner is cut. A length, so it scales with the
 *   box. Figma's second control is separate for a reason: see smoothing below.
 * - **smoothing** (0..1) — how ROUND an already-cut corner is. 0 is a circular
 *   arc, higher flattens the junction so the corner reads as a squircle. Figma's
 *   `iOS` preset is 0.6. It is shape-wide, so it has nothing consistent to apply
 *   when a rect's four radii differ.
 *
 * This component is the ONLY place a corner radius is edited.
 *
 * Rendered for the shapes that have corners at all: the four that store
 * `borderRadius` (rect, frame, component, instance) plus polygon and star, which
 * store a single `cornerRadius`.
 *
 * Headerless by contract: the corner fields render inside the APPEARANCE
 * section, whose header carries the independent-corners switch
 * (`IndependentCornersToggle`) — this component draws fields only. The
 * `data-inspector-section="corner"` marker stays on the wrapper so probes can
 * still address the field group.
 */
export function CornerControls({
  elements,
  doc,
  docRef,
  is4Corners,
  onToggle4Corners,
  onMutate,
  onCommitSnapshot,
  onDragStart,
  onDragEnd
}: CornerControlsProps) {
  const [tokenPickerAnchor, setTokenPickerAnchor] = useState<HTMLElement | null>(null);
  const [cornerPicker, setCornerPicker] = useState<{ corner: keyof typeof CORNERS; anchor: HTMLElement } | null>(null);
  const selected = elements[0];
  if (!selected) return null;

  // Offered when AT LEAST ONE selected layer has corners. The other layers do not
  // refuse the edit, they simply have nowhere to store it — so the field is mixed
  // rather than gone, and typing a radius lands on the ones that can hold it.
  const storesBorderRadius = elements.some(isBorderRadiusHolder);
  const isGeneratedOutline = elements.some((el) => el.type === "polygon" || el.type === "star");
  if (!storesBorderRadius && !isGeneratedOutline) return null;

  const cornerProp = isBorderRadiusHolder(selected) ? "borderRadius" : "cornerRadius";
  const boundTokenId =
    selected.tokenBindings?.[cornerProp] ??
    (() => {
      if (cornerProp === "borderRadius" && selected.tokenBindings) {
        const b = selected.tokenBindings;
        const tl = b.topLeftRadius ?? b.borderTopLeftRadius;
        const tr = b.topRightRadius ?? b.borderTopRightRadius;
        const br = b.bottomRightRadius ?? b.borderBottomRightRadius;
        const bl = b.bottomLeftRadius ?? b.borderBottomLeftRadius;
        if (tl && tl === tr && tl === br && tl === bl) return tl;
      }
      return undefined;
    })();
  const boundToken = doc ? findNumberToken(doc.tokens ?? [], boundTokenId) : undefined;
  const isMissingToken = Boolean(boundTokenId && !boundToken);

  /** The radius a single number stands for: a stored array's first corner. */
  const radiusOf = (el: DesignElement): number => {
    if (el.type === "instance" && (el as any).borderRadius === undefined) {
      const docCurrent = docRef?.current ?? doc;
      if (docCurrent) {
        const master = findMasterComponent(docCurrent, (el as any).componentId);
        if (master && master.borderRadius !== undefined) {
          return Array.isArray(master.borderRadius) ? (master.borderRadius[0] ?? 0) : (master.borderRadius ?? 0);
        }
      }
    }
    if (isBorderRadiusHolder(el)) {
      return Array.isArray(el.borderRadius) ? (el.borderRadius[0] ?? 0) : (el.borderRadius ?? 0);
    }
    return (el as { cornerRadius?: number }).cornerRadius ?? 0;
  };
  const radius = resolveAcross(elements, radiusOf);

  const canSmooth = elements.every((el) => hasCornerSmoothing(el));
  const smoothingOf = (el: DesignElement): number => {
    if (typeof (el as { cornerSmoothing?: number }).cornerSmoothing === "number") {
      return (el as { cornerSmoothing?: number }).cornerSmoothing as number;
    }
    if (el.type === "instance") {
      const docCurrent = docRef?.current ?? doc;
      if (docCurrent) {
        const master = findMasterComponent(docCurrent, (el as any).componentId);
        if (master && typeof (master as any).cornerSmoothing === "number") {
          return (master as any).cornerSmoothing;
        }
      }
    }
    return 0;
  };
  const smoothing = resolveAcross(elements, smoothingOf);

  const setRadius = (v: number) =>
    onMutate((el) => {
      const prop = isBorderRadiusHolder(el) ? "borderRadius" : "cornerRadius";
      const detached = unbindNumberTokenFromElement(el, prop);
      if (isBorderRadiusHolder(detached)) return { ...detached, borderRadius: Math.max(0, v) };
      if (detached.type === "polygon" || detached.type === "star") return { ...detached, cornerRadius: Math.max(0, v) };
      return detached;
    });

  const setSmoothing = (v: number, discrete?: boolean) =>
    onMutate(
      (el) =>
        hasCornerSmoothing(el) ? { ...el, cornerSmoothing: Math.min(1, Math.max(0, v)) } : el,
      discrete
    );

  return (
    <div className="space-y-2" data-inspector-section="corner">
      {storesBorderRadius && elements.every(isBorderRadiusHolder) && is4Corners ? (
        /* Reading order of the 2×2 grid — TL TR / BL BR — which is NOT the
           storage order: `parseCornerRadii` follows CSS and runs clockwise from
           the top-left, so `slot` is what indexes it. */
        <>
          <div className="grid grid-cols-2 gap-1">
            {CORNER_ORDER.map((corner) => {
              const slot = CORNERS[corner].slot;
              const prop = CORNER_TOKEN_PROPS[corner];
              const alias = CORNER_TOKEN_ALIASES[corner];
              const boundId = selected.tokenBindings?.[prop] ?? selected.tokenBindings?.[alias];
              const boundTok = doc ? findNumberToken(doc.tokens ?? [], boundId) : undefined;
              const isMissing = Boolean(boundId && !boundTok);

              const radii = resolveAcross(elements, (el) =>
                isBorderRadiusHolder(el) ? parseCornerRadii(el.borderRadius)[slot] ?? 0 : 0
              );
              return (
                <ScrubInput
                  key={corner}
                  label={cornerLabel(corner)}
                  value={radii.mixed ? undefined : radii.value}
                  mixed={radii.mixed}
                  min={0}
                  title={t(CORNER_TITLES[corner])}
                  tokenName={boundTok?.name ?? (isMissing ? t("tokens.missing") : undefined)}
                  onOpenTokenPicker={doc ? (anchor) => setCornerPicker({ corner, anchor }) : undefined}
                  onDetachToken={
                    boundId
                      ? () => {
                          onMutate((el) => unbindNumberTokenFromElement(el, prop));
                        }
                      : undefined
                  }
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onChange={(val) => {
                    onMutate((el) => {
                      if (!isBorderRadiusHolder(el)) return el;
                      const detached = unbindNumberTokenFromElement(el, prop);
                      if (!isBorderRadiusHolder(detached)) return detached;
                      const next = parseCornerRadii(detached.borderRadius).slice() as [number, number, number, number];
                      next[slot] = val;
                      return { ...detached, borderRadius: next };
                    });
                  }}
                />
              );
            })}
          </div>
          {cornerPicker && doc && (
            <NumberTokenPicker
              doc={doc}
              docRef={docRef}
              anchor={cornerPicker.anchor}
              boundTokenId={
                selected.tokenBindings?.[CORNER_TOKEN_PROPS[cornerPicker.corner]] ??
                selected.tokenBindings?.[CORNER_TOKEN_ALIASES[cornerPicker.corner]]
              }
              currentValue={
                isBorderRadiusHolder(selected)
                  ? parseCornerRadii(selected.borderRadius)[CORNERS[cornerPicker.corner].slot] ?? 0
                  : 0
              }
              category="radius"
              onSelect={(tok) => {
                if (docRef && !docRef.current.tokens?.some((t) => t.id === tok.id)) {
                  docRef.current = addTokenToDoc(docRef.current, tok);
                }
                onMutate((el) => {
                  const prop = CORNER_TOKEN_PROPS[cornerPicker.corner];
                  return bindNumberTokenToElement(el, prop, tok.id, tok.value);
                });
              }}
              onDetach={() => {
                onMutate((el) => {
                  const prop = CORNER_TOKEN_PROPS[cornerPicker.corner];
                  return unbindNumberTokenFromElement(el, prop);
                });
              }}
              onCommitSnapshot={onCommitSnapshot}
              onClose={() => setCornerPicker(null)}
            />
          )}
        </>
      ) : (
        <>
          {/* Icon only. The field used to read `[icon] R` — the letter named a
              number no header names any more, and that the 2×2 grid in the other
              mode disambiguates by position; the icon stays because it is the
              one thing that tells a radius field from any other single-value
              field at a glance. */}
          <ScrubInput
            label={<SquareRoundCorner size={11} className="shrink-0" />}
            value={radius.mixed ? undefined : Math.round(radius.value * 100) / 100}
            mixed={radius.mixed}
            min={0}
            title={t("properties.cornerRadius")}
            tokenName={boundToken?.name ?? (isMissingToken ? t("tokens.missing") : undefined)}
            onOpenTokenPicker={doc ? (anchor) => setTokenPickerAnchor(anchor) : undefined}
            onDetachToken={
              boundTokenId
                ? () => {
                    onMutate((el) => {
                      const prop = isBorderRadiusHolder(el) ? "borderRadius" : "cornerRadius";
                      return unbindNumberTokenFromElement(el, prop);
                    });
                  }
                : undefined
            }
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChange={setRadius}
          />
          {tokenPickerAnchor && doc && (
            <NumberTokenPicker
              doc={doc}
              docRef={docRef}
              anchor={tokenPickerAnchor}
              boundTokenId={boundTokenId}
              currentValue={radius.value}
              category="radius"
              onSelect={(tok) => {
                if (docRef && !docRef.current.tokens?.some((t) => t.id === tok.id)) {
                  docRef.current = addTokenToDoc(docRef.current, tok);
                }
                onMutate((el) => {
                  const prop = isBorderRadiusHolder(el) ? "borderRadius" : "cornerRadius";
                  return bindNumberTokenToElement(el, prop, tok.id, tok.value);
                });
              }}
              onDetach={() => {
                onMutate((el) => {
                  const prop = isBorderRadiusHolder(el) ? "borderRadius" : "cornerRadius";
                  return unbindNumberTokenFromElement(el, prop);
                });
              }}
              onCommitSnapshot={onCommitSnapshot}
              onClose={() => setTokenPickerAnchor(null)}
            />
          )}
        </>
      )}

      {canSmooth && (
        <ScrubInput
          /* The key is the WORD, not a glyph. A spline icon in a key slot said
             nothing a user could repeat back, and it is exactly the failure the
             component/instance marks taught: an unlabelled glyph is a riddle.
             "Smooth" is what the field does. */
          label={t("properties.smooth")}
          value={smoothing.mixed ? undefined : Math.round(smoothing.value * 100)}
          mixed={smoothing.mixed}
          min={0}
          max={100}
          title={t("properties.cornerSmoothing")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onChange={(v) => setSmoothing(v / 100)}
          // Figma ships this exact button, and it is the fastest way to see what the
          // control does — 0.6 is the value their docs call the iOS squircle. It
          // lives INSIDE the field it sets, so it cannot be read as a control of its
          // own with its own value.
          trailing={
            <button
              type="button"
              data-corner-preset="ios"
              onClick={() => setSmoothing(IOS_SQUIRCLE, true)}
              title={t("properties.cornerSmoothingIos")}
              className="flex-none pl-1 pr-[7px] text-unit text-ink-muted hover:text-brand transition-colors"
            >
              {t("properties.cornerSmoothingIos")}
            </button>
          }
        />
      )}
    </div>
  );
}