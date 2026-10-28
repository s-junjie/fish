import type { DesignDocument, DesignElement } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";
import { layoutOf } from "../../core/dsl/layout-flat";
import { findParentById } from "../../core/geometry/tree-ops";
import { ConstraintsWidget } from "../ConstraintsWidget";
import { Section } from "./SectionHeader";
import { t } from "../../i18n";

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
 */
export function ConstraintsSection({ primarySelected, doc, onMutate }: ConstraintsSectionProps) {
  const parent = findParentById(getActivePage(doc).children, primarySelected.id);
  if (!parent) return null;

  const parentPlacesChildren = Boolean(parent && layoutOf(parent));
  const leftTheFlow = primarySelected.position === "absolute";
  const canConstrain = !parentPlacesChildren || leftTheFlow;

  if (!canConstrain) return null;

  return (
    <Section id="constraints" title={t("stack.constraints")}>
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
    </Section>
  );
}
