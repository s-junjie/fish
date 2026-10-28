import { ComponentOverride, DesignDocument, DesignElement, InstanceElement } from "../../core/dsl/types";
import {
  removeInstanceOverrideProperty,
  removeInstanceOverrides
} from "../../core/interactions/component-ops";
import { componentSwapOptions, swapNestedInstance } from "../../core/interactions/component-swap";
import {
  findComponentSet,
  findVariantMember,
  variantOptionsFor
} from "../../core/interactions/component-inventory";
import { resolveInstanceSelection } from "../../core/interactions/instance-resolve";
import { InstanceSwapPicker } from "./InstanceSwapPicker";
import { InstanceVariantSection } from "./InstanceVariantSection";
import { Section } from "./SectionHeader";
import { InstanceMark } from "../ComponentMark";
import { TokenTag } from "../TokenTag";
import { t } from "../../i18n";
import { RotateCcw, ExternalLink } from "lucide-react";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";

interface InstanceChildSectionProps {
  primarySelected: DesignElement;
  docRef: { current: DesignDocument };
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  setSelectedIds: (ids: Set<string>) => void;
  /** Selects a main component, switching pages first when it lives elsewhere. */
  onLocateComponent?: (componentId: string) => void;
  /** One-line notice for a change that happens outside the inspector. */
  onHint?: (message: string) => void;
}

/** The tag on an overridden property. Falls back to the stored key when unnamed. */
function overrideLabel(property: ComponentOverride["property"]): string {
  const key = `component.overrideLabel.${property}`;
  const label = t(key);
  return label === key ? property : label;
}

export function InstanceChildSection({
  primarySelected,
  docRef,
  onCommitSnapshot,
  setSelectedIds,
  onLocateComponent,
  onHint
}: InstanceChildSectionProps) {
  const sel = resolveInstanceSelection(docRef.current, primarySelected.id);
  if (!sel) return null;

  const node = primarySelected;
  const overrides = (sel.instance.overrides || []).filter((o) => o.targetId === sel.masterNodeId);

  const goToMain = () => {
    // Same page caveat as ComponentSection: a master can live elsewhere.
    if (onLocateComponent) onLocateComponent(sel.master.id);
    else setSelectedIds(new Set([sel.master.id]));
  };

  const resetNode = () => {
    const next = removeInstanceOverrides(docRef.current, sel.instanceId, sel.masterNodeId);
    if (next) onCommitSnapshot(next);
  };

  const resetProperty = (property: ComponentOverride["property"]) => {
    const next = removeInstanceOverrideProperty(
      docRef.current,
      sel.instanceId,
      sel.masterNodeId,
      property
    );
    if (next) onCommitSnapshot(next);
  };

  const nestedInstance = sel.overridable && node.type === "instance" ? (node as InstanceElement) : null;
  const swapOptions = nestedInstance
    ? componentSwapOptions(docRef.current, t("component.defaultVariantLabel"), node.id)
    : [];
  const swapNested = (nextComponentId: string) => {
    const next = swapNestedInstance(docRef.current, node.id, nextComponentId);
    if (next) onCommitSnapshot(next);
  };

  /**
   * A nested instance is a full instance of its own master, so it answers its
   * set's axes exactly like a top-level one. Leaving them out — the old reading,
   * where only the flat swap list was drawn — made the most common edit on a
   * composed component (the state of the button inside the card) unreachable
   * without going to the main component and coming back.
   */
  const set = nestedInstance ? findComponentSet(docRef.current, nestedInstance.componentId) : null;
  const currentVariant =
    set?.members.find((m) => m.id === nestedInstance!.componentId)?.variantProperties ?? {};
  const variantRows = (set?.properties ?? []).map((p) => ({
    property: p.property,
    value: currentVariant[p.property] ?? p.values[0] ?? "",
    options: variantOptionsFor(set!, p.property, currentVariant)
  }));
  const setVariant = (property: string, value: string) => {
    if (!set) return;
    const member = findVariantMember(set, { ...currentVariant, [property]: value });
    if (member) {
      swapNested(member.id);
      return;
    }
    // A hole in the set's matrix: the dropdown offered a combination no member
    // fills, and saying nothing would read as a broken control.
    onHint?.(t("component.variantCombinationMissing"));
  };

  return (
    <div className="space-y-2 pt-2" data-testid="instance-child-section">
      <div className="flex items-center justify-between min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <InstanceMark size={13} className="shrink-0 text-component" />
          <span className="text-row text-ink truncate font-medium">
            {sel.instance.name || t("component.instance")}
          </span>
          <span className="text-meta text-ink-dim truncate">
            · {node.name || node.type}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {overrides.length > 0 && (
            <Button
              size="icon"
              onClick={resetNode}
              title={t("component.resetNodeOverrides")}
            >
              <RotateCcw size={12} />
            </Button>
          )}
          <Button
            size="icon"
            onClick={goToMain}
            title={t("component.goToMain")}
          >
            <ExternalLink size={12} />
          </Button>
        </div>
      </div>

      {sel.overridable ? (
        <div data-instance-child-overridable="true">
          {/* What this node has already changed, one removable tag per property:
              the same all-or-nothing reset above cannot express "give me the
              master's fill back but keep my radius". */}
          {overrides.length > 0 && (
            <div className="flex flex-wrap gap-1" data-instance-override-tags="true">
              {overrides.map((o) => {
                const label = overrideLabel(o.property);
                const tip = t("component.resetProperty", { name: label });
                return (
                  <TokenTag
                    key={o.property}
                    name={label}
                    title={tip}
                    detachTitle={tip}
                    onDetach={() => resetProperty(o.property)}
                    tagProps={{ "data-instance-override": o.property }}
                  />
                );
              })}
            </div>
          )}

          {nestedInstance && variantRows.length > 0 && (
            <Section
              id="nested-variant"
              title={t("component.variantAxes")}
              className="space-y-1.5 pt-1"
              data-nested-instance-variants="true"
            >
              <InstanceVariantSection variantRows={variantRows} onSetVariant={setVariant} />
            </Section>
          )}

          {nestedInstance && swapOptions.length > 1 && (
            <Section
              id="nested-swap"
              title={t("component.swapNested")}
              className="space-y-1.5 pt-1"
              data-nested-instance-swap="true"
            >
              <InstanceSwapPicker
                options={swapOptions}
                value={nestedInstance.componentId}
                onSelect={swapNested}
                label={t("component.swapNested")}
              />
            </Section>
          )}
        </div>
      ) : (
        <div className={SUB_LABEL_CLASS}>{t("component.nestedHint")}</div>
      )}
    </div>
  );
}
