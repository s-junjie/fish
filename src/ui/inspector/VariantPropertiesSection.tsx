import { ComponentElement, ComponentSetElement, DesignDocument } from "../../core/dsl/types";
import {
  addVariant,
  addVariantProperty,
  removeVariant,
  setVariantValue
} from "../../core/interactions/component-variants";
import { variantTableOf } from "../../core/interactions/component-inventory";
import { t } from "../../i18n";
import { VARIANT_LABELS } from "./variant-labels";
import { Plus, Trash2 } from "lucide-react";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { ACTION_BAR_CLASS, ACTION_BAR_ON, ACTION_BAR_OFF, ACTION_BUTTON_CLASS } from "./action-bar-style";
import { ROW_SPREAD_GAP_CLASS } from "../row-style";

/**
 * One variant's own panel in the Inspector.
 *
 * In Figma, when selecting a variant inside a component set:
 * - Shows the property name and the current variant's value, editable as a
 *   combobox over the values the set already declares.
 * - Provides a quick "+" button to add another variant state.
 * - Shows a delete button to remove this variant.
 *
 * Editing a VALUE here writes that one member's coordinates. Renaming a value
 * across the whole set is the matrix's job (`VariantSetMatrix`), because only
 * there does the cell stand for a column rather than for one member — the two
 * readings of the same keystroke, and the panel used to answer with the wrong
 * one: changing a member's `State` renamed every member that shared it.
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
  const members = (set.children ?? []) as ComponentElement[];
  const primaryProp = properties[0];
  const firstPropName = primaryProp?.property ?? VARIANT_LABELS.property(1);

  const handleAddNextVariant = () => {
    const res = addVariant(docRef.current, comp.id, VARIANT_LABELS, firstPropName);
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

  const canRemove = members.length > 1;

  return (
    <div className="space-y-1.5 pt-1" data-variant-properties={set.id}>
      {properties.map((prop) => {
        const propName = prop.property;
        const val = comp.variantProperties?.[propName] ?? "";
        const listId = `variant-values-${comp.id}-${propName}`;
        return (
          <div
            key={propName}
            className={ROW_SPREAD_GAP_CLASS}
            data-variant-property-row={propName}
          >
            <span
              data-variant-property={propName}
              title={propName}
              className="text-meta text-ink-dim w-24 truncate select-none"
            >
              {propName}
            </span>

            <div className="flex-1 min-w-0" data-variant-property-value={propName}>
              <input
                key={`${comp.id}-${propName}-${val}`}
                data-variant-cell={val}
                name="variant-value"
                defaultValue={val}
                placeholder="—"
                list={listId}
                onBlur={(e) => {
                  const next = (e.target as HTMLInputElement).value.trim();
                  if (next && next !== val) {
                    commit(setVariantValue(docRef.current, set.id, comp.id, propName, next));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className={TEXT_FIELD_CLASS}
              />
              <datalist id={listId}>
                {prop.values.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-1.5 pt-1">
        <button
          type="button"
          data-variant-add-next="true"
          onClick={handleAddNextVariant}
          className={`${ACTION_BUTTON_CLASS} ${ACTION_BAR_ON}`}
          title={t("component.addVariant")}
        >
          <Plus size={11} />
          <span>{t("component.addVariant")}</span>
        </button>
        <button
          type="button"
          data-variant-remove="true"
          onClick={handleRemove}
          disabled={!canRemove}
          className={`${ACTION_BUTTON_CLASS} ${canRemove ? ACTION_BAR_ON : ACTION_BAR_OFF}`}
          title={t("component.removeVariant")}
        >
          <Trash2 size={11} />
          <span>{t("component.removeVariant")}</span>
        </button>
      </div>
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
