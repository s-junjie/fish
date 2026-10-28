import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { AssetRef, ColorToken, DesignDocument, GradientStop, ImagePaint, Paint, PatternPaint } from "../core/dsl/types";
import {
  HSV,
  composeColorAlpha,
  hexToHsv,
  hsvToHex,
  parseColorAlpha
} from "../core/geometry/color-utils";
import { getGradientStops, isGradientPaint } from "../core/geometry/gradient-utils";
import { t } from "../i18n";
import { PanelHeader } from "./PanelHeader";
import { Select } from "./Select";
import { HUE_TRACK, Rail, alphaTrackStyle } from "./ColorRail";
import { ColorValueFields } from "./ColorValueFields";
import { pickerDepth, setPickerOpen } from "./hooks/picker-focus";
import { useAnchoredPosition } from "./hooks/useAnchoredPosition";
import { useColorNotation } from "./hooks/useColorNotation";
import { useDismiss } from "./hooks/useDismiss";
import { ImagePaintBody } from "./ImagePaintBody";
import { PatternPaintBody } from "./PatternPaintBody";
import {
  ALL_PAINT_TABS,
  GRADIENT_KINDS,
  GradientKind,
  PaintKind,
  PaintTab,
  gradientKindLabel,
  tabLabel,
  tabOf
} from "./paint-kind";
import { DARK_RING_CLASS } from "./ring-style";
import { COLOR_PANEL_WIDTH, placeColorPanel, type PanelDecision } from "./color-panel/placement";
import {
  emptyKindMemory,
  gradientSwitchPaint,
  imageSwitchPaint,
  patternSwitchPaint,
  rememberPaint,
  type KindMemory
} from "./color-panel/kind-memory";
import { withStops, detachedStop } from "./color-panel/stop-edit";
import { GradientStopBar } from "./color-panel/GradientStopBar";
import { ColorTokenPicker } from "./inspector/ColorTokenPicker";
import { colorTokenColor } from "../core/interactions/token-ops";

const ADJUST_LIST_MAX_HEIGHT = 168;
/** Stand-in shown when image mode is requested but the document has no bitmap. */
const PENDING_IMAGE_PAINT: ImagePaint = { type: "image", assetId: "", fit: "cover" };
const noop = () => { };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

interface ColorPanelProps {
  title?: ComponentChildren;
  paint: Paint;
  anchor: HTMLElement | null;
  zIndex?: string;
  /**
   * Which tabs the switcher offers. Omitted means all three; an empty list hides
   * the switcher entirely.
   *
   * A list rather than a boolean because "no gradients" was never the real
   * question — a canvas background and a drop-shadow colour want a SOLID picker
   * with no switcher at all, while the selected-colours strip wants solid and
   * gradients but NOT image: an image fill has no colour of its own, so it is not
   * one of that strip's rows and cannot be keyed on one.
   */
  tabs?: PaintTab[];
  /**
   * `discrete` true means "final value of a click", not a step of a drag.
   *
   * `cause` separates editing a value from CHANGING KIND, and a caller that
   * refuses a cross-kind write needs the difference: the guard that protects a
   * stored gradient from a stray hex only makes sense while the kind cannot
   * change under it.
   */
  onChange: (paint: Paint, discrete?: boolean, cause?: "value" | "kind") => void;
  /** Bracket a continuous gesture so the whole drag lands as one undo entry. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onClose: () => void;
  /** Document assets, so an image layer can preview and re-point its bitmap. */
  assets?: AssetRef[];
  /**
   * Adopt a locally picked file as this layer's bitmap. The HOST performs the
   * upload and commits the new asset together with the re-pointed layer in one
   * snapshot — a two-step version would briefly leave the paint referencing an
   * asset that is not in the document yet, and undo would stop in between.
   */
  onUploadImage?: (file: File) => void;
  /** Switch this layer to crop mode and hand the canvas the chrome. */
  onEnterCrop?: () => void;
  /** This layer is the one the canvas is currently cropping. */
  cropActive?: boolean;
  /**
   * The document, so a gradient stop can follow a colour token. Omitted by a
   * caller with no document in hand, which hides the affordance rather than
   * offering one that resolves nothing.
   */
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
}

export function ColorPanel({
  title,
  paint,
  anchor,
  zIndex,
  tabs = ALL_PAINT_TABS,
  onChange,
  onGestureStart,
  onGestureEnd,
  onClose,
  assets,
  onUploadImage,
  onEnterCrop,
  cropActive = false,
  doc,
  docRef
}: ColorPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const svRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const svDragging = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [notation, setNotation] = useColorNotation();

  // The panel is mounted exactly while it is open, so mounting is the moment it
  // takes the keyboard and unmounting is the moment it gives it back.
  const depth = useRef(0);
  useEffect(() => {
    setPickerOpen(true);
    // Its own level in the picker stack, read once: a nested colour picker
    // (a pattern body's colour row) pushes the count above this, which is what
    // tells this panel to leave the next press and Escape to the child.
    depth.current = pickerDepth();
    return () => setPickerOpen(false);
  }, []);

  const assetList = assets ?? [];
  const kind: PaintKind = paint.type;
  // Image mode can be *requested* while there is nothing to paint yet. The body
  // is then shown so the upload button is reachable, but the paint is left
  // alone: an image paint without an `assetId` fails normalization and would be
  // dropped from the fill stack on the next save. `displayKind` is what the
  // switcher and the body follow, so the request is still visible.
  const [pendingImage, setPendingImage] = useState(false);
  useEffect(() => {
    if (kind === "image") setPendingImage(false);
  }, [kind]);
  const displayKind: PaintKind = pendingImage ? "image" : kind;
  const activeTab = tabOf(displayKind);
  const isImage = displayKind === "image";

  // What each kind last painted, so stepping through the switcher and back is
  // non-destructive. Written during render, because the next thing to read it is
  // an event handler and an effect would still be a render behind.
  const memory = useRef<KindMemory>(emptyKindMemory());
  rememberPaint(memory.current, paint);

  const gradient = isGradientPaint(paint) ? paint : null;
  const isGradient = gradient !== null;
  const stops = gradient ? getGradientStops(gradient) : [];
  const [stopIndexRaw, setStopIndex] = useState(0);
  const stopIndex = Math.min(stopIndexRaw, Math.max(0, stops.length - 1));

  const activeColor = kind === "image"
    ? "#FFFFFF"
    : kind === "pattern"
      ? (paint as PatternPaint).foreground
      : isGradient
        ? stops[stopIndex]?.color ?? "#FFFFFF"
        : (paint as { color: string }).color;
  const parsed = parseColorAlpha(activeColor);

  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(parsed.hex6));
  const lastHex = useRef(parsed.hex6);
  useEffect(() => {
    if (parsed.hex6 === lastHex.current) return;
    lastHex.current = parsed.hex6;
    setHsv(hexToHsv(parsed.hex6));
  }, [parsed.hex6]);

  // --- placement: the side, the offset and the clamp are decided in
  // `./color-panel/placement`, which is where the reasoning lives.
  // `anchor` is a prop and the hook wants a ref; the mirror is written during
  // render, which is what makes it correct on the very first measurement.
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const decisionRef = useRef<PanelDecision | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const pos = useAnchoredPosition({
    anchorRef,
    panelRef,
    // `displayKind` is a dependency because the side decision is made from the
    // body's height, and switching kind changes that height.
    deps: [anchor, maxHeight, displayKind],
    compute: (anchorEl, panelEl) => {
      const placed = placeColorPanel({
        anchor: anchorEl,
        panel: panelEl,
        kind: displayKind,
        isImage,
        previous: decisionRef.current,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
      decisionRef.current = placed.decision;
      setMaxHeight(placed.maxHeight);
      return { left: placed.left, top: placed.top };
    }
  });

  useDismiss(true, () => closeRef.current(), panelRef, anchorRef, [
    // A press on the canvas gradient lever is an edit of the paint this panel has
    // open, not a dismissal: closing here would unmount the lever's activation
    // state mid-drag. Crop mode is the same bargain for the same reason, and it has
    // to name the WHOLE overlay rather than only its handles — the body of the
    // bitmap is itself a grab surface, so a press on it is the move gesture.
    "[data-gradient-handle]",
    "[data-image-crop-overlay]",
    // A pattern layer's two colours are `ColorField`s, and a ColorField opens a
    // picker of its own — so this panel can be the HOST of another one. The child
    // is portaled to `body`, i.e. outside this panel by every test `useDismiss`
    // makes, so without this the press meant to change a colour closed the window
    // it was opened from.
    "[data-color-panel]",
    // The token picker behind a gradient stop is this panel's own child, and it
    // is portaled to `body` too — without this, the press that chooses a token
    // closed the panel the picker was anchored in.
    "[data-color-token-picker]"
  ],
  // …and a press or an Escape with that child on screen is ITS to answer: closing
  // both at once is what made changing a pattern's colour feel like a crash.
  () => pickerDepth() > depth.current);

  // Enter confirms the pick and closes — but only when the panel itself holds the
  // keyboard. Handled in the CAPTURE phase so it cannot reach the editor's own
  // Enter handling (leave vector edit mode, enter it, drill into the selection)
  // while the panel is what is on screen.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== "Enter") return;
      const target = e.target as HTMLElement | null;
      // A field in the NESTED picker (a pattern body's colour row) belongs to that
      // panel — which answers its own Enter — so committing it must not also close
      // the one it was opened from.
      if (target?.closest?.("[data-color-panel]") && !panelRef.current?.contains(target)) return;
      // A field in the token picker is the picker's to commit; Enter there must
      // not close the panel it was opened from.
      if (target?.closest?.("[data-color-token-picker]")) return;
      // A dropdown owns Enter: the browser opens its popup with it, and a select
      // that dismissed the panel it lives in instead would be unusable from the
      // keyboard — the kind row and the gradient dialect are both selects.
      if (target?.tagName === "SELECT" && panelRef.current?.contains(target)) return;
      // A field of this panel: its own keydown commits the typed value, and the
      // panel STAYS. Closing on that commit turned every confirmed number — a
      // stop's offset, an angle, a hex — into a dismissal of the whole picker
      // mid-edit. Nothing is stopped here: that listener runs later in the
      // propagation, and the field owns the commit.
      if (
        target &&
        panelRef.current?.contains(target) &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // --- paint mutations
  const applyStops = (next: GradientStop[], discrete?: boolean) => {
    if (!gradient) return;
    onChange(withStops(gradient, next), discrete);
  };

  // --- stop colour tokens
  const [stopTokenAnchor, setStopTokenAnchor] = useState<HTMLElement | null>(null);

  const activeStopToken = (() => {
    const id = stops[stopIndex]?.tokenId;
    if (!id) return null;
    const token = (doc?.tokens ?? []).find(
      (entry): entry is ColorToken => entry.type === "color" && entry.id === id
    );
    return { id, name: token?.name || id };
  })();

  const bindStopToken = (token: ColorToken) => {
    if (!gradient) return;
    const color = colorTokenColor(token, doc?.activeTheme);
    applyStops(
      stops.map((s, i) => (i === stopIndex ? { ...s, tokenId: token.id, color } : s)),
      true
    );
    setStopTokenAnchor(null);
  };

  const detachStopToken = () => {
    applyStops(stops.map((s, i) => (i === stopIndex ? detachedStop(s) : s)), true);
    setStopTokenAnchor(null);
  };

  const emitColor = (hex6: string, alphaPct: number, discrete?: boolean, updateHsv = true) => {
    lastHex.current = hex6;
    if (updateHsv) {
      setHsv(hexToHsv(hex6));
    }
    const color = composeColorAlpha(hex6, alphaPct);
    if (isGradient) {
      // Editing a stop's colour detaches it: a stop that kept its token would be
      // overwritten by the next cascade, which reads as the picker not working.
      applyStops(
        stops.map((s, i) => (i === stopIndex ? { ...detachedStop(s), color } : s)),
        discrete
      );
    } else {
      // Explicit: spreading the gradient paint here would carry from/to/stops
      // (and radial geometry) onto a solid, surviving until the next normalize.
      onChange({ type: "solid", color }, discrete);
    }
  };

  const emitHsv = (next: HSV) => {
    setHsv(next);
    emitColor(hsvToHex(next), parsed.alphaPct, false, false);
  };

  const setKind = (next: PaintKind) => {
    if (next === displayKind) return;
    if (next === "image") {
      // Never open the file picker on the user's behalf: with nothing in the
      // document to paint, the upload button is what chooses a file — so show the
      // image body and leave the paint alone.
      const nextPaint = imageSwitchPaint(memory.current, assetList);
      if (!nextPaint) {
        setPendingImage(true);
        return;
      }
      setPendingImage(false);
      onChange(nextPaint, true, "kind");
      return;
    }
    setPendingImage(false);
    if (next === "pattern") {
      onChange(patternSwitchPaint(memory.current, activeColor), true, "kind");
      return;
    }
    if (next === "solid") {
      onChange({ type: "solid", color: activeColor }, true, "kind");
      return;
    }
    onChange(gradientSwitchPaint(next, paint, stops, activeColor, memory.current), true, "kind");
    setStopIndex(0);
  };

  const setTab = (tab: PaintTab) => {
    if (tab === activeTab) return;
    // "Gradient" is a tab, not a kind: which of the four it opens on is the
    // last one this panel was on.
    setKind(tab === "gradient" ? memory.current.gradientKind ?? "linear-gradient" : tab);
  };

  const scrubSv = (clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    emitHsv({
      h: hsv.h,
      s: clamp01((clientX - rect.left) / rect.width) * 100,
      v: (1 - clamp01((clientY - rect.top) / rect.height)) * 100
    });
  };

  const hasEyeDropper = typeof window !== "undefined" && "EyeDropper" in window;
  const pickFromScreen = async () => {
    try {
      const eyeDropper = new (window as any).EyeDropper();
      const result = await eyeDropper.open();
      if (result?.sRGBHex) {
        const nextParsed = parseColorAlpha(result.sRGBHex);
        emitColor(nextParsed.hex6, parsed.alphaPct, true);
      }
    } catch {
      /* dismissed by the user */
    }
  };

  const hueHex = hsvToHex({ h: hsv.h, s: 100, v: 100 });

  return createPortal(
    <div
      ref={panelRef}
      data-color-panel="1"
      data-field-tab-scope="color-panel"
      data-inspector-activity="true"
      role="dialog"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: COLOR_PANEL_WIDTH,
        maxHeight: maxHeight ?? undefined,
        overflowY: maxHeight === null ? undefined : "auto",
        visibility: pos ? "visible" : "hidden"
      }}
      /* `bg-panel` + `rounded-pill`, i.e. the same shell every other popover
         wears (DESIGN.md §Components → popover, and `POPOVER_SURFACE_CLASS`).
         This panel used to be `bg-surface` on a 9px radius, which is neither
         of the two elevations the shell has: a popover's base is `panel`, and
         `surface` is the SECOND step, for chrome nested inside one. Painting
         the popover itself `surface` collapsed that nesting — which is why the
         tab strip below had to go down to `bg-panel` to stay visible, i.e. the
         inner control was darker than its own container, backwards.
         Restoring the base means the strip moves UP to `surface` instead. */
      className={`fixed ${zIndex ?? "z-[60]"} bg-panel border border-rule-strong rounded-pill shadow-popover px-2.5 pt-2 pb-2.5 space-y-2 text-ui text-ink select-none ${
        // Image mode is a column so the viewport's clamp lands on the axis list
        // instead of on the panel: a capped flex box shrinks its flexible item,
        // and every other row here is `shrink-0`. The other kinds have no such
        // item, so they keep the plain scrollable body.
        isImage ? "flex flex-col" : ""
        }`}
    >
      <PanelHeader
        title={title ?? t("paint.color")}
        onClose={onClose}
        className="pb-1.5 border-b border-rule shrink-0"
      />

      {/* The kind is a DROPDOWN, not four segments.
          Four labels in a 220px track is a width the labels do not have: at
          `text-row` the English four come to 188px of a 220px box, and the same
          four in Japanese — 全塗りつぶし / グラデーション / 画像 / パターン — do
          not fit at any padding. A segmented strip that must truncate is a strip
          whose segments stop naming anything. One field shows the kind in full,
          in any language, and it is the same object as the gradient dialect
          below it: type, then variant.
          A single kind is not a choice, so it renders nothing. */}
      {tabs.length > 1 && (
        <Select
          className="w-full shrink-0"
          data-paint-kind-select="1"
          value={activeTab}
          onChange={(next) => setTab(next as PaintTab)}
          title={t("paint.kind")}
        >
          {tabs.map((tab) => (
            <option key={tab} value={tab} data-paint-tab={tab}>
              {tabLabel(tab)}
            </option>
          ))}
        </Select>
      )}

      {/* Which gradient. The row directly under the kind, so the pair reads
          type → variant, and the second field only exists while the first says
          Gradient. */}
      {tabs.includes("gradient") && activeTab === "gradient" && (
        /* A DROPDOWN, not four segments.
           Four dialect labels side by side do not fit a 240px panel: measured
           at `px-2` they need 221px of label in a 216px track, and `px-1.5`
           only bought 5px of that. A segment that cannot hold its own label
           spills over its neighbour, which is worse than a control that shows
           one value and hides the rest — the choice is not the point of the
           row, the chosen gradient is. The four names stay in the DOM as
           `<option data-paint-kind>`, so the e2e suite still reads them. */
        <Select
          className="w-full"
          data-gradient-kinds="1"
          value={displayKind as GradientKind}
          onChange={(k) => setKind(k as GradientKind)}
          title={t("paint.gradient")}
        >
          {GRADIENT_KINDS.map((k) => (
            <option key={k} value={k} data-paint-kind={k}>
              {gradientKindLabel(k)}
            </option>
          ))}
        </Select>
      )}

      {isImage ? (
        <ImagePaintBody
          paint={kind === "image" ? (paint as ImagePaint) : PENDING_IMAGE_PAINT}
          assets={assetList}
          onChange={kind === "image" ? onChange : noop}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
          onUpload={() => fileRef.current?.click()}
          onEnterCrop={onEnterCrop}
          cropActive={cropActive}
          /* One scroller, never two — and it is the LIST, at every viewport.
             This cap is what the window is worth while the panel fits; once the
             viewport clamps the panel, the flex column above hands the deficit
             down to the list, so the bar moves to the shorter axis list rather
             than onto the whole panel. */
          slidersMaxHeight={ADJUST_LIST_MAX_HEIGHT}
          pending={kind !== "image"}
        />
      ) : activeTab === "pattern" && kind === "pattern" ? (
        <PatternPaintBody
          paint={paint as PatternPaint}
          onChange={onChange}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      ) : (
        <>
          {/* Saturation / value field */}
          <div
            ref={svRef}
            data-sv-area="1"
            className="relative w-full h-[120px] rounded-ctl border border-rule-strong overflow-hidden cursor-crosshair"
            style={{
              backgroundImage: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${hueHex})`
            }}
            onPointerDown={(e) => {
              svDragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              onGestureStart?.();
              scrubSv(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (svDragging.current) scrubSv(e.clientX, e.clientY);
            }}
            onPointerUp={(e) => {
              if (!svDragging.current) return;
              svDragging.current = false;
              try {
                e.currentTarget.releasePointerCapture(e.pointerId);
              } catch { }
              onGestureEnd?.();
            }}
          >
            <div
              className={`absolute w-3 h-3 rounded-full border-2 border-rule-strong ${DARK_RING_CLASS} pointer-events-none`}
              style={{
                left: `calc(${hsv.s}% - 6px)`,
                top: `calc(${100 - hsv.v}% - 6px)`,
                background: parsed.hex6
              }}
            />
          </div>

          {/* Hue and alpha read as one instrument, so they are spaced apart and
              off the field above them — at the panel's own `space-y-2` the two
              rails sat a track-width apart and read as one striped block. */}
          <div className="space-y-3 pt-1">
            {/* Hue */}
            <Rail
              name="hue"
              pct={(hsv.h / 360) * 100}
              trackStyle={{ backgroundImage: HUE_TRACK }}
              onScrubStart={() => onGestureStart?.()}
              onScrub={(ratio) => emitHsv({ ...hsv, h: ratio * 360 })}
              onScrubEnd={() => onGestureEnd?.()}
            />

            {/* Alpha */}
            <Rail
              name="alpha"
              pct={parsed.alphaPct}
              trackStyle={alphaTrackStyle(parsed.hex6)}
              onScrubStart={() => onGestureStart?.()}
              onScrub={(ratio) => emitColor(parsed.hex6, ratio * 100, false, false)}
              onScrubEnd={() => onGestureEnd?.()}
            />
          </div>

          <ColorValueFields
            notation={notation}
            onNotationChange={setNotation}
            color={activeColor}
            onHexChange={(nextHex, alphaPct, discrete = true) => {
              emitColor(nextHex, alphaPct ?? parsed.alphaPct, discrete, true);
            }}
            onAlphaChange={(pct) => emitColor(parsed.hex6, pct, false, false)}
            onGestureStart={onGestureStart}
            onGestureEnd={onGestureEnd}
            onPickFromScreen={hasEyeDropper ? pickFromScreen : undefined}
            hexInputAttrs={{ "data-hex-input": "1" }}
          />

          {gradient && (
            <GradientStopBar
              paint={gradient}
              stops={stops}
              stopIndex={stopIndex}
              onStopsChange={applyStops}
              onSelectStop={setStopIndex}
              onAngleChange={(next) => onChange(next, false)}
              stopToken={activeStopToken}
              onOpenTokenPicker={
                doc
                  ? (anchor) => setStopTokenAnchor((cur) => (cur ? null : anchor))
                  : undefined
              }
              onDetachToken={activeStopToken ? detachStopToken : undefined}
              onGestureStart={onGestureStart}
              onGestureEnd={onGestureEnd}
            />
          )}

          {gradient && doc && stopTokenAnchor && (
            <ColorTokenPicker
              doc={doc}
              docRef={docRef}
              anchor={stopTokenAnchor}
              currentColor={stops[stopIndex]?.color ?? "#FFFFFF"}
              boundTokenId={activeStopToken?.id}
              onSelect={bindStopToken}
              onDetach={detachStopToken}
              onClose={() => setStopTokenAnchor(null)}
            />
          )}
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        name="paint-image-file"
        accept="image/*"
        hidden
        className="hidden"
        onChange={(e) => {
          const files = (e.currentTarget as HTMLInputElement).files;
          if (files && files[0]) onUploadImage?.(files[0]);
          (e.currentTarget as HTMLInputElement).value = "";
        }}
      />
    </div>,
    document.body
  );
}
