import { ComponentElement, ComponentSetElement, DesignDocument } from "../../core/dsl/types";
import {
  addVariant,
  addVariantPropertyToSet,
  removeVariant,
  removeVariantProperty,
  removeVariantValue,
  renameVariantProperty,
  renameVariantValue,
  setVariantValue
} from "../../core/interactions/component-variants";
import { variantTableOf } from "../../core/interactions/component-inventory";
import { t } from "../../i18n";
import { VARIANT_LABELS } from "./variant-labels";
import { InstanceMark, VariantSetMark } from "../ComponentMark";
import { Plus, Trash2 } from "lucide-react";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { ACTION_BAR_CLASS, ACTION_BAR_ON } from "./action-bar-style";
import { SUB_LABEL_CLASS } from "../label-tier";
import { Button } from "../Button";

/**
 * Component Set panel in the Inspector (aligned with Figma).
 *
 * Shows:
 * - Component Set title & rename input
 * - Properties section: list of all property axes (with rename, delete if >1, and "+ Add property")
 * - Variants list: each member row with coordinates inputs for each property
 * - "+ Add variant" button
 */
export function VariantSetMatrix({
  set,
  docRef,
  onCommitSnapshot,
  onSelectVariant
}: {
  set: ComponentSetElement;
  docRef: { current: DesignDocument };
  onCommitSnapshot: (doc: DesignDocument) => void;
  onSelectVariant?: (id: string) => void;
}) {
  const members = (set.children ?? []) as ComponentElement[];
  const properties = variantTableOf(set);
  const commit = (next: DesignDocument | null) => {
    if (next) onCommitSnapshot(next);
  };

  const primaryProp = properties[0];
  const firstPropName = primaryProp?.property ?? VARIANT_LABELS.property(1);

  // Figma's default variant is the top-left one, so "+" copies that rather than arbitrary
  const defaultId = members
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)[0]?.id;

  const addVariantMember = () => {
    if (!defaultId) return;
    const res = addVariant(docRef.current, defaultId, VARIANT_LABELS, firstPropName);
    if (res.doc) {
      commit(res.doc);
      if (res.variant) {
        onSelectVariant?.(res.variant.id);
      }
    }
  };

  const addProperty = () => {
    const res = addVariantPropertyToSet(docRef.current, set.id, VARIANT_LABELS);
    if (res.property) commit(res.doc);
  };

  return (
    <div className="space-y-2.5 pt-3" data-variant-matrix={set.id}>
      {/* The set's name and nothing else. This row used to read
          `[mark] Component Set [editable name] [member count]` — the type, then
          the name, then a number nobody asked for, in a 288px panel. The mark
          already says "set"; the name is the only thing here that identifies
          anything. It is no longer an input either: renaming lives in the Layers
          panel, where every other layer is renamed, so this row stopped being the
          one place that behaved differently. */}
      <div className="flex items-center gap-1.5 min-w-0">
        <VariantSetMark size={13} className="shrink-0 text-component" />
        <span className="text-row text-ink truncate">{set.name}</span>
      </div>

      {/* Properties list / Matrix */}
      <div className="space-y-3">
        {properties.map((prop) => {
          const propName = prop.property;
          const values = prop.values;
          return (
            <div key={propName} className="space-y-1.5">
              {/* Property Header: Name, add variant, delete axis */}
              <div className="flex items-center justify-between gap-1 group">
                <input
                  data-variant-property={propName}
                  name="variant-property"
                  defaultValue={propName}
                  title={propName}
                  onBlur={(e) => {
                    const input = e.target as HTMLInputElement;
                    const next = input.value.trim();
                    if (next && next !== propName) {
                      commit(renameVariantProperty(docRef.current, set.id, propName, next));
                    } else {
                      input.value = propName;
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className={`flex-1 ${TEXT_FIELD_CLASS}`}
                />
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="icon"
                    type="button"
                    data-variant-add="true"
                    data-variant-add-button="true"
                    title={t("component.addVariant")}
                    onClick={() => {
                      if (!defaultId) return;
                      const res = addVariant(docRef.current, defaultId, VARIANT_LABELS, propName);
                      if (res.doc) {
                        commit(res.doc);
                        if (res.variant) {
                          onSelectVariant?.(res.variant.id);
                        }
                      }
                    }}
                  >
                    <Plus size={11} />
                  </Button>
                  {properties.length > 1 && (
                    <Button
                      size="icon"
                      variant="danger"
                      type="button"
                      title={t("component.removeVariantProperty")}
                      onClick={() => commit(removeVariantProperty(docRef.current, set.id, propName))}
                    >
                      <Trash2 size={12} />
                    </Button>
                  )}
                </div>
              </div>

              {/* Variants for this property */}
              <div className="space-y-1">
                {values.map((val) => {
                  const membersWithValue = members.filter(
                    (m) => (m.variantProperties?.[propName] ?? "") === val
                  );
                  return (
                    <div
                      key={val}
                      className="flex items-center gap-1.5 group/val py-0.5 px-1 rounded-ctl hover:bg-raised transition-colors text-row"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (membersWithValue[0]) {
                            onSelectVariant?.(membersWithValue[0].id);
                          }
                        }}
                        title={membersWithValue.map((m) => m.name).join(", ")}
                        className="shrink-0 text-component hover:opacity-80 cursor-default"
                      >
                        <InstanceMark size={13} className="shrink-0" />
                      </button>
                      <input
                        data-variant-cell={val}
                        name="variant-value"
                        defaultValue={val}
                        placeholder="—"
                        onBlur={(e) => {
                          const next = (e.target as HTMLInputElement).value.trim();
                          if (next && next !== val) {
                            commit(renameVariantValue(docRef.current, set.id, propName, val, next));
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        className={`flex-1 ${TEXT_FIELD_CLASS}`}
                      />
                      {(members.length > 1 || membersWithValue.length === 0) && (
                        <Button
                          size="icon"
                          variant="danger"
                          type="button"
                          title={
                            membersWithValue.length === 0
                              ? t("component.removeVariantValue")
                              : t("component.removeVariant")
                          }
                          onClick={() => {
                            // A value nobody fills has no member to remove: the
                            // row IS the leftover, so the trash takes the value
                            // out of the table. Left unhandled it looped over an
                            // empty list and did nothing.
                            if (membersWithValue.length === 0) {
                              commit(removeVariantValue(docRef.current, set.id, propName, val));
                              return;
                            }
                            let currDoc = docRef.current;
                            for (const m of membersWithValue) {
                              const nextDoc = removeVariant(currDoc, m.id);
                              if (nextDoc) currDoc = nextDoc;
                            }
                            commit(currDoc);
                          }}
                        >
                          <Trash2 size={12} />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* A second axis is a property of the SET, not of any member, so the
          control that adds one sits under the whole matrix rather than on a
          row. It was defined and never rendered, which left the slash-naming
          merge as the only route to a multi-axis set. */}
      {properties.length > 0 && (
        <button
          type="button"
          data-variant-add-property="true"
          onClick={addProperty}
          className={`${ACTION_BAR_CLASS} ${ACTION_BAR_ON}`}
          title={t("component.addProperty")}
        >
          <Plus size={13} className="shrink-0" />
          <span>{t("component.addProperty")}</span>
        </button>
      )}

      {/* Add Variant Footer Button (only when no property and no variant exist) */}
      {properties.length === 0 && (
        <div className="pt-3">
          <button
            type="button"
            data-variant-add="true"
            data-variant-add-button="true"
            onClick={addVariantMember}
            className={`${ACTION_BAR_CLASS} ${ACTION_BAR_ON}`}
          >
            <Plus size={13} className="shrink-0" />
            <span>{t("component.addVariant")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
