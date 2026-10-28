import { DesignElement } from "../../core/dsl/types";
import { ScrubInput } from "../ScrubInput";
import { Section } from "./SectionHeader";
import { t } from "../../i18n";
import { resolveAcross } from "./mixed";
import {
  DraftingCompass,
  Radius,
  RotateCw,
  BetweenHorizontalStart,
  Star
} from "lucide-react";

/** The per-shape fields, seen without the discriminated union the branch above
 *  has already narrowed past. */
type LooseShape = { [field: string]: unknown };

interface ShapeGeometrySectionProps {
  /** The whole selection. Each field writes through `onMutate`, which broadcasts,
   *  and every one of these properties is one number per layer. */
  elements: DesignElement[];
  onMutate: (updater: (el: DesignElement) => DesignElement) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/**
 * The controls that decide what a simple shape IS, as opposed to where it sits.
 *
 * Split out of `TransformSection` because it is a different question with a
 * different answer per type: position and size apply to everything, while these
 * fields exist only for the shape that has them — four for an ellipse's arcs and
 * ring, three for a star's spikes. Grouping them by shape here keeps the
 * vocabulary in one file, and a third polygonal shape gets one more block.
 *
 * Renders nothing for a type with no geometry controls, so the caller does not
 * have to ask which types those are.
 */
export function ShapeGeometrySection({
  elements,
  onMutate,
  onDragStart,
  onDragEnd
}: ShapeGeometrySectionProps) {
  /**
   * Offered when EVERY selected layer is of the shape — not when the first one is.
   *
   * Gating on the primary hid the whole block the moment two ellipses were
   * selected, which is the one case where setting the same sweep on both is the
   * obvious edit. A selection mixing an ellipse with a rectangle has no honest
   * value for "the sweep" of the pair, so the block goes: half a shape's
   * vocabulary next to a rectangle is chrome for a property that does not exist on
   * half the selection.
   */
  const isEllipse = elements.length > 0 && elements.every((el) => el.type === "ellipse");
  const isStar = elements.length > 0 && elements.every((el) => el.type === "star");
  const isPolygon = elements.length > 0 && elements.every((el) => el.type === "polygon");

  /**
   * Read one of these numbers across the selection, with its mixed flag.
   *
   * The reads go through a loose record rather than a narrowed element type: the
   * branch above has already established that every member IS an ellipse (or a
   * star), and TypeScript cannot carry that through a callback.
   */
  const num = (read: (el: DesignElement) => number) => resolveAcross(elements, read);
  const numberAt = (el: DesignElement, key: string, fallback: number) => {
    const v = (el as unknown as LooseShape)[key];
    return typeof v === "number" ? v : fallback;
  };
  const sweep = num((el) => numberAt(el, "sweep", 360));
  const ellipseInner = num((el) => numberAt(el, "innerRadius", 0));
  const startAngle = num((el) => numberAt(el, "startAngle", 0));
  const gap = num((el) => numberAt(el, "gap", 0));
  const points = num((el) => numberAt(el, "points", 5));
  const starInner = num((el) => numberAt(el, "innerRadius", 0.382));
  // Corners are NOT here — `CornerControls` owns radius + smoothing in the
  // APPEARANCE section, so each of those values has exactly one field
  // in the whole panel. This component is only the per-shape vocabulary: an
  // ellipse's arcs and a star's points and spike depth. A polygon's side
  // count lives in `AutoLayoutSection`, which already branches on polygon
  // for the layout header — one branch, one block, not two.
  if (!isEllipse && !isStar && !isPolygon) return null;

  return (
    <>
      {isEllipse && (
        <Section id="shape" title={t("shape.title")}>
          <div className="grid grid-cols-2 gap-1">
            <ScrubInput
              label={<DraftingCompass size={11} />}
              value={sweep.mixed ? undefined : Math.round(sweep.value)}
              mixed={sweep.mixed}
              min={0}
              max={360}
              title={t("shape.sweep")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onMutate((el) => (el.type === "ellipse" ? { ...el, sweep: v } : el))}
            />
            <ScrubInput
              label={<Radius size={11} />}
              value={ellipseInner.mixed ? undefined : Math.round(ellipseInner.value * 100)}
              mixed={ellipseInner.mixed}
              min={0}
              max={99}
              title={t("shape.innerRadius")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onMutate((el) => (el.type === "ellipse" ? { ...el, innerRadius: v / 100 } : el))}
            />
          </div>

          <div className="grid grid-cols-2 gap-1">
            <ScrubInput
              label={<RotateCw size={11} />}
              value={startAngle.mixed ? undefined : Math.round(startAngle.value)}
              mixed={startAngle.mixed}
              min={0}
              max={360}
              title={t("shape.startAngle")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onMutate((el) => (el.type === "ellipse" ? { ...el, startAngle: v } : el))}
            />
            <ScrubInput
              label={<BetweenHorizontalStart size={11} />}
              value={gap.mixed ? undefined : Math.round(gap.value)}
              mixed={gap.mixed}
              min={0}
              max={180}
              title={t("shape.gap")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) => onMutate((el) => (el.type === "ellipse" ? { ...el, gap: v } : el))}
            />
          </div>
        </Section>
      )}

      {isStar && (
        <Section id="shape" title={t("shape.title")}>
          <div className="grid grid-cols-2 gap-1">
            <ScrubInput
              label={<Star size={11} />}
              value={points.mixed ? undefined : Math.round(points.value)}
              mixed={points.mixed}
              min={3}
              max={60}
              title={t("shape.points")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) =>
                onMutate((el) => (el.type === "star" ? { ...el, points: Math.round(v) } : el))
              }
            />
            <ScrubInput
              // Same field as the ellipse's above, so the same glyph: the icon
              // names the PROPERTY, and the label says what it does to this
              // shape. One picture per field beats one picture per effect.
              label={<Radius size={11} />}
              value={starInner.mixed ? undefined : Math.round(starInner.value * 100)}
              mixed={starInner.mixed}
              min={0}
              max={99}
              title={t("shape.starInnerRadius")}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onChange={(v) =>
                onMutate((el) => (el.type === "star" ? { ...el, innerRadius: v / 100 } : el))
              }
            />
          </div>
        </Section>
      )}
    </>
  );
}