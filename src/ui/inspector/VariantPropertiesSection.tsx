import { ComponentElement, ComponentSetElement, DesignDocument } from "../../core/dsl/types";
import {
  addVariant,
  addVariantProperty,
  removeVariant,
  renameVariantValue,
  setVariantValue
} from "../../core/interactions/component-variants";
import { variantTableOf } from "../../core/interactions/component-inventory";
import { t } from "../../i18n";
import { VARIANT_LABELS } from "./variant-labels";
import { InstanceMark } from "../ComponentMark";
import { Plus, Trash2 } from "lucide-react";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { ACTION_BAR_CLASS, ACTION_BAR_ON } from "./action-bar-style";
import { Button } from "../Button";
import { ROW_SPREAD_GAP_CLASS } from "../row-style";

/**
 * One variant's own panel in the Inspector.
 *
 * In Figma, when selecting a variant inside a component set:
 * - Shows the property name (editable) and the current variant's value (editable via text input/dropdown).
 * - Provides a quick "+" button to add another variant state.
 * - Shows a delete button to remove this variant.
 *
 * For a lone main component without a set, provides "+ Add variant" to turn it
 * into a component set with its first variant property.
 */
export function VariantPropertiesSection({
  comp,
  set,
  docRef,
  onCommitSnapshot,
  onSelectSet
}: {
  comp: ComponentElement;
  /** The node holding `comp`, or null when it is a lone main component. */
  set: ComponentSetElement | null;
  docRef: { current: DesignDocument };
  onCommitSnapshot: (doc: DesignDocument) => void;
  /** Used to follow the selection onto a set or newly created variant. */
  onSelectSet?: (setId: string) => void;
}) {
  const commit = (next: DesignDocument | null) => {
    if (next) onCommitSnapshot(next);
  };

  if (!set) {
    return (
      <div className="space-y-2 pt-3" data-variant-properties="none">
        <AddFirstProperty
          comp={comp}
          docRef={docRef}
          onCommitSnapshot={onCommitSnapshot}
          onSelectSet={onSelectSet}
        />
      </div>
    );
  }

  const properties = variantTableOf(set);
  const primaryProp = properties[0];
  const propName = primaryProp?.property ?? VARIANT_LABELS.property(1);
  const currentValue = comp.variantProperties?.[propName] ?? "";
  const members = (set.children ?? []) as ComponentElement[];

  const handleAddNextVariant = () => {
    const res = addVariant(docRef.current, comp.id, VARIANT_LABELS, propName);
    if (res.doc) {
      commit(res.doc);
      if (res.variant) {
        onSelectSet?.(res.variant.id);
      }
    }
  };

  const handleRemove = () => {
    commit(removeVariant(docRef.current, comp.id));
  };

  return (
    <div className="space-y-1.5 pt-1" data-variant-properties={set.id}>
      {properties.map((prop) => {
        const propName = prop.property;
        const val = comp.variantProperties?.[propName] ?? "";
        return (
          <div
            key={propName}
            className={ROW_SPREAD_GAP_CLASS}
            data-variant-property-row={propName}
          >
            {/* Property Name Label */}
            <span
              data-variant-property={propName}
              title={propName}
              className="text-meta text-ink-dim w-24 truncate select-none"
            >
              {propName}
            </span>

            {/* Variant Value Input */}
            <div className="flex-1 min-w-0" data-variant-property-value={propName}>
              <input
                key={`${comp.id}-${propName}-${val}`}
                data-variant-cell={val}
                name="variant-value"
                defaultValue={val}
                placeholder="—"
                onBlur={(e) => {
                  const next = (e.target as HTMLInputElement).value.trim();
                  if (next && next !== val) {
                    if (val) {
                      commit(renameVariantValue(docRef.current, set.id, propName, val, next));
                    } else {
                      commit(setVariantValue(docRef.current, set.id, comp.id, propName, next));
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className={TEXT_FIELD_CLASS}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Affordance on a lone main component: "+ Add variant".
 * Turning the main component into a component set with its first variant property.
 */
function AddFirstProperty({
  comp,
  docRef,
  onCommitSnapshot,
  onSelectSet
}: {
  comp: ComponentElement;
  docRef: { current: DesignDocument };
  onCommitSnapshot: (doc: DesignDocument) => void;
  onSelectSet?: (setId: string) => void;
}) {
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-variant-property-first="true"
        onClick={() => {
          const made = addVariantProperty(docRef.current, comp.id, VARIANT_LABELS);
          if (!made.set) return;
          onCommitSnapshot(made.doc);
          onSelectSet?.(made.set.id);
        }}
        className={`${ACTION_BAR_CLASS} ${ACTION_BAR_ON}`}
      >
        <Plus size={13} className="shrink-0" />
        <span>{t("component.addVariant")}</span>
      </button>
    </div>
  );
}