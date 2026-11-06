import type { DesignDocument, DesignElement, ElementScrollBehavior } from "../../core/dsl/types";
import { ConstraintsWidget } from "../ConstraintsWidget";
import { Section } from "./SectionHeader";
import { Select } from "../Select";
import { SUB_LABEL_CLASS } from "../label-tier";
import { t } from "../../i18n";
import {
  canConstrainChild,
  parentPlacesChildren,
  parentScrollOf,
  selectionParent
} from "./selection-parent";

interface ConstraintsSectionProps {
  primarySelected: DesignElement;
  doc: DesignDocument;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
}

/**
 * Per-child resize pinning. `resizeContainerWithConstraints` is the engine half and
 * it branches on exactly two things (src/core/geometry/constraints.ts): a parent
 * with no `layout` constrains EVERY child, a parent with one constrains only the
 * children that left the flow. This section mirrors those two branches and nothing
 * else — an availability test that asks a different question than the engine (a
 * `mode === "flex"` test does) hides the widget in exactly the case it exists for,
 * and offers it where the engine ignores the value.
 *
 * A layer inside an instance is the third answer, and it is not a constraint
 * question at all: that geometry is the master's, so the section keeps only the
 * scroll half for it. See `canConstrainChild`.
 */
export function ConstraintsSection({ primarySelected, doc, onMutate }: ConstraintsSectionProps) {
  const parent = selectionParent(doc, primarySelected);
  if (!parent) return null;

  const canConstrain = canConstrainChild(primarySelected, parentPlacesChildren(doc, parent));
  const scroll = parentScrollOf(doc, parent);
  const parentHasScroll = scroll.clipContent && scroll.scrollOverflow !== "none";

  if (!canConstrain && !parentHasScroll) return null;

  const scrollBehavior = primarySelected.scrollBehavior ?? "scroll";

  return (
    <Section id="constraints" title={t("stack.constraints")}>
      {canConstrain && (
        <div data-constraints-widget="true">
          <ConstraintsWidget
            constraints={primarySelected.constraints}
            onChange={(next) => {
              onMutate((el) => ({
                ...el,
                constraints: next
              }), true);
            }}
          />
        </div>
      )}

      {parentHasScroll && (
        <div className={`flex items-center justify-between gap-2${canConstrain ? " mt-2" : ""}`}>
          <span className={SUB_LABEL_CLASS}>{t("stack.scrollBehavior")}</span>
          <Select
            className="w-36"
            value={scrollBehavior}
            onChange={(val) => {
              onMutate((el) => ({
                ...el,
                scrollBehavior: val === "scroll" ? undefined : (val as ElementScrollBehavior)
              }), true);
            }}
          >
            <option value="scroll">{t("stack.scrollWithParent")}</option>
            <option value="fixed">{t("stack.scrollFixed")}</option>
            <option value="sticky">{t("stack.scrollSticky")}</option>
          </Select>
        </div>
      )}
    </Section>
  );
}
