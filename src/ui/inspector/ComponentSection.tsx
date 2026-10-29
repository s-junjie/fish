import { DesignDocument, DesignElement, ComponentElement, ComponentSetElement, InstanceElement } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";
import { createComponentFromElement, detachInstance, hasAnythingToReset, instanceOwnFields, resetInstance, resetInstanceField, type InstanceOwnField } from "../../core/interactions/component-ops";
import { canBecomeComponent, canCreateComponentHere, collectComponents, findComponentSet, findMasterComponent, findVariantMember, variantHoles, variantOptionsFor } from "../../core/interactions/component-inventory";
import { componentSwapOptions, swapInstanceComponent } from "../../core/interactions/component-swap";
import { InstanceSwapPicker } from "./InstanceSwapPicker";
import { InstanceVariantSection } from "./InstanceVariantSection";
import { VariantPropertiesSection } from "./VariantPropertiesSection";
import { setNodeOf } from "./set-node";
import { VariantSetMatrix } from "./VariantSetMatrix";
import { combineAsVariants } from "../../core/interactions/component-variants";
import { VARIANT_LABELS } from "./variant-labels";
import { Section } from "./SectionHeader";
import { ComponentMark, InstanceMark, VariantSetMark } from "../ComponentMark";
import { TokenTag } from "../TokenTag";
import { SUB_LABEL_CLASS } from "../label-tier";
import { overrideLabel } from "./override-label";
import type { ComponentChildren } from "preact";
import { t } from "../../i18n";
import { RotateCcw, Unlink, ExternalLink } from "lucide-react";
import { promotionTargets, promoteSelectionToComponents } from "../../core/interactions/component-batch";
import { ACTION_BAR_CLASS, ACTION_BAR_OFF, ACTION_BAR_ON } from "./action-bar-style";
import { Button } from "../Button";

interface ComponentSectionProps {
  primarySelected: DesignElement;
  /** The whole selection — a batch promotion needs more than the primary node. */
  selectedElements: DesignElement[];
  docRef: { current: DesignDocument };
  onCommitSnapshot: (newDoc: DesignDocument) => void;
  setSelectedIds: (ids: Set<string>) => void;
  /** Selects a main component, switching pages first when it lives elsewhere. */
  onLocateComponent?: (componentId: string) => void;
  /** One-line notice for a change that happens outside the inspector. */
  onHint?: (message: string) => void;
}

export function ComponentSection({
  primarySelected,
  selectedElements,
  docRef,
  onCommitSnapshot,
  setSelectedIds,
  onLocateComponent,
  onHint
}: ComponentSectionProps) {
  const handleCreateComponent = () => {
    const { doc: nextDoc, component, hoisted } = createComponentFromElement(
      docRef.current,
      primarySelected.id
    );
    if (component) {
      onCommitSnapshot(nextDoc);
      setSelectedIds(new Set([component.id]));
      // A promotion that moved layers is invisible from here — the master is now
      // sitting next to the component, off the inspector's radar (§7).
      if (hoisted.length > 0 && onHint) onHint(t("component.hoistedMaster"));
    }
  };

  /**
   * A batch promotion is the same operation applied once per top-level selected
   * element: each becomes its own component and they are selected together, so the
   * whole batch can be moved or deleted as one. See `promotionTargets` for which
   * of the selection counts.
   */
  const multiSelected = selectedElements.length > 1;
  const batchTargets = promotionTargets(getActivePage(docRef.current).children, selectedElements);

  const handleCreateComponents = () => {
    const res = promoteSelectionToComponents(docRef.current, batchTargets);
    if (!res) return;
    onCommitSnapshot(res.doc);
    setSelectedIds(new Set(res.created));
    if (res.hoisted && onHint) onHint(t("component.hoistedMaster"));
  };

  const canCreateHere = canCreateComponentHere(getActivePage(docRef.current).children, primarySelected);

  const batchLabel =
    batchTargets.length > 1 ? t("component.createComponents") : t("component.createComponent");
  const allSelectedAreComponents =
    multiSelected &&
    selectedElements.length >= 2 &&
    selectedElements.every((el) => el.type === "component");

  const handleCombineVariants = () => {
    if (!allSelectedAreComponents) return;
    const res = combineAsVariants(
      docRef.current,
      selectedElements.map((el) => el.id),
      VARIANT_LABELS
    );
    if (res) {
      onCommitSnapshot(res.doc);
      setSelectedIds(new Set([res.setId]));
    }
  };

  /**
   * One bar, three reasons for it: combine a multi-selection of components,
   * promote a batch, or promote the one layer that is selected. They differ only
   * in wording and target, so they share the box.
   */
  const promote = (
    onClick: () => void,
    mark: ComponentChildren,
    label: string,
    title: string,
    enabled: boolean,
    data: Record<string, string | number>
  ) => (
    <div className="pt-3">
      <button
        type="button"
        onClick={onClick}
        disabled={!enabled}
        {...data}
        className={`${ACTION_BAR_CLASS} ${enabled ? ACTION_BAR_ON : ACTION_BAR_OFF}`}
        title={title}
      >
        {mark}
        <span>{label}</span>
      </button>
    </div>
  );

  const createButton = multiSelected ? (
    allSelectedAreComponents ? (
      promote(
        handleCombineVariants,
        <VariantSetMark size={13} className="shrink-0 text-component" />,
        t("component.combineAsVariants"),
        `${t("component.combineAsVariants")} (${selectedElements.length})`,
        true,
        { "data-combine-as-variants": "true" }
      )
    ) : batchTargets.length > 0 ? (
      promote(
        handleCreateComponents,
        <ComponentMark size={13} className="shrink-0 text-component" />,
        batchLabel,
        `${batchLabel} (${batchTargets.length})`,
        true,
        { "data-create-components": batchTargets.length }
      )
    ) : null
  ) : canBecomeComponent(primarySelected) ? (
    promote(
      handleCreateComponent,
      <ComponentMark size={13} className={`shrink-0 ${canCreateHere ? "text-component" : "text-ink-muted"}`} />,
      t("component.createComponent"),
      canCreateHere ? `${t("component.createComponent")} (⌥⌘K)` : t("component.nestedMaster"),
      canCreateHere,
      { "data-create-component": "true" }
    )
  ) : null;

  // A component SET is its own panel: Figma shows the matrix — one row per
  // property, one column per variant — and nothing else, because every edit it can
  // make is a coordinate of a member and the members are the other thing selected
  // alongside it. Selecting a set therefore never shows a promote button either.
  const componentSectionHeader =
    primarySelected.type === "componentSet"
      ? t("component.componentSet")
      : primarySelected.type === "instance"
      ? t("component.instance")
      : t("component.header");

  if (primarySelected.type === "componentSet") {
    return (
      <Section id="component" title={componentSectionHeader} className="">
        <VariantSetMatrix
          set={primarySelected as ComponentSetElement}
          docRef={docRef}
          onCommitSnapshot={onCommitSnapshot}
          onSelectVariant={(id) => setSelectedIds(new Set([id]))}
        />
      </Section>
    );
  }

  if (primarySelected.type === "component") {
    return (
      <Section id="component" title={componentSectionHeader} className="">
        <VariantPropertiesSection
          comp={primarySelected as ComponentElement}
          set={setNodeOf(docRef.current, primarySelected)}
          docRef={docRef}
          onCommitSnapshot={onCommitSnapshot}
          onSelectSet={(setId) => setSelectedIds(new Set([setId]))}
        />
      </Section>
    );
  }
  if (primarySelected.type === "instance") {
    const inst = primarySelected as InstanceElement;
    const master = findMasterComponent(docRef.current, inst.componentId);

    const handleGoToMain = () => {
      if (!master) return;
      // A master on another page cannot be reached by id alone: selecting an id
      // the active page does not contain selects nothing. main.tsx owns the
      // page switch, so route through it whenever it is available.
      if (onLocateComponent) onLocateComponent(master.id);
      else setSelectedIds(new Set([master.id]));
    };

    /**
     * `resetInstance` owns the "is there anything to reset" question and returns
     * null when the answer is no, so a pristine instance no longer produces an
     * undo step and a dirty document with nothing on screen changed.
     */
    const handleReset = () => {
      const nextDoc = resetInstance(docRef.current, inst.id);
      if (nextDoc) onCommitSnapshot(nextDoc);
    };

    const handleDetach = () => {
      const { doc: nextDoc, frame } = detachInstance(docRef.current, inst.id, master || undefined);
      if (frame) {
        onCommitSnapshot(nextDoc);
        setSelectedIds(new Set([frame.id]));
        return;
      }
      // A missing master made this button a silent no-op.
      onHint?.(t("component.detachNeedsMaster"));
    };

    /** Drives the Reset button, and matches what `resetInstance` would accept. */
    const instanceDirty = hasAnythingToReset(inst, master ?? undefined);

    const entries = collectComponents(docRef.current);
    const set = findComponentSet(docRef.current, inst.componentId);
    const currentVariant =
      set?.members.find((m) => m.id === inst.componentId)?.variantProperties ?? {};

    const swapTo = (nextComponentId: string) => {
      const next = swapInstanceComponent(docRef.current, inst.id, nextComponentId);
      if (next) onCommitSnapshot(next);
    };

    const setVariant = (property: string, value: string) => {
      if (!set) return;
      const member = findVariantMember(set, { ...currentVariant, [property]: value });
      if (member) {
        swapTo(member.id);
        return;
      }
      // The options are narrowed to existing combinations, so this is a hole in
      // the set that no member fills — and the one case where saying nothing
      // would look exactly like a broken dropdown.
      onHint?.(t("component.variantCombinationMissing"));
    };

    const swapOptions = componentSwapOptions(docRef.current, inst.id, entries);

    /**
     * What this instance has changed, one removable tag each. Before this the
     * panel could only say "something is different" (the Reset button lit up) and
     * answer with "all of it": a user who tried a fill and kept the copy had no
     * way to give back just the fill.
     */
    const ownFields = instanceOwnFields(inst, master ?? undefined);
    const childOverrides = (inst.overrides ?? []).length;
    const handleResetField = (field: InstanceOwnField) => {
      const nextDoc = resetInstanceField(docRef.current, inst.id, field);
      if (nextDoc) onCommitSnapshot(nextDoc);
    };

    /**
     * What the instance IS, in the user's vocabulary: its set's name when it
     * belongs to one, its master's name otherwise. `master.name` for a variant is
     * the coordinate string (`Size=Medium, State=Default`), which named the cell
     * and never the component.
     */
    const identity = set ? set.name : master?.name || t("component.missingComponent");

    return (
      <Section id="component" title={componentSectionHeader} className="">
        {/* An instance is promotable like anything else: ⌥⌘K and the context menu
            both wrap it in a component, and `canBecomeComponent` says yes. Without
            this bar the panel was the only one of the three entry points that could
            not do it. */}
        {createButton}
        {/* Instance info & actions container */}
        <div className="space-y-3 pt-3">
          {/* One row: what it is, how to change it, what can be done to it. The
              name IS the swap control — Figma's header — so picking another
              component is one click from the thing it changes, and the separate
              "Swap instance" section at the bottom of the panel (a second place
              for the same question) is gone. */}
          <div className="flex items-center justify-between gap-1.5 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <InstanceMark size={13} className="shrink-0 text-component" />
              {swapOptions.length > 1 ? (
                <InstanceSwapPicker
                  className="flex-1 min-w-0"
                  options={swapOptions}
                  value={inst.componentId}
                  onSelect={swapTo}
                />
              ) : (
                <span className="font-sans text-ui text-ink truncate min-w-0" title={identity}>
                  {identity}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {master && (
                <Button
                  size="icon"
                  onClick={handleGoToMain}
                  title={t("component.goToMain")}
                >
                  <ExternalLink size={12} />
                </Button>
              )}
              <Button
                size="icon"
                onClick={handleReset}
                disabled={!instanceDirty}
                data-instance-reset="true"
                title={instanceDirty ? t("component.resetOverrides") : t("component.resetNothing")}
              >
                <RotateCcw size={12} />
              </Button>
              <Button
                size="icon"
                onClick={handleDetach}
                data-instance-detach="true"
                title={`${t("component.detachInstance")} (⌥⌘B)`}
              >
                <Unlink size={12} />
              </Button>
            </div>
          </div>

          {/* What it has changed, above what it is configured with: the tags are
              the answer to "why is my Reset lit", and each one is removable on its
              own. Child overrides are summarised rather than listed — a card with
              nine changed layers would fill the panel with tags whose names live
              in the layer tree. */}
          {(ownFields.length > 0 || childOverrides > 0) && (
            <div className="flex flex-wrap items-center gap-1" data-instance-override-tags="true">
              {ownFields.map((field) => {
                const label = overrideLabel(field);
                const tip = t("component.resetProperty", { name: label });
                return (
                  <TokenTag
                    key={field}
                    name={label}
                    title={tip}
                    detachTitle={tip}
                    onDetach={() => handleResetField(field)}
                    tagProps={{ "data-instance-own-field": field }}
                  />
                );
              })}
              {childOverrides > 0 && (
                <span className={`${SUB_LABEL_CLASS} truncate`} data-instance-child-override-count={childOverrides}>
                  {t("component.childOverrideCount", { count: childOverrides })}
                </span>
              )}
            </div>
          )}

          {/* The one thing an instance can be configured with. */}
          <InstanceVariantSection
            variantRows={(set?.properties ?? []).map((p) => ({
              property: p.property,
              value: currentVariant[p.property] ?? p.values[0] ?? "",
              options: variantOptionsFor(set!, p.property, currentVariant),
              holes: variantHoles(set!, p.property, currentVariant)
            }))}
            onSetVariant={setVariant}
          />
        </div>
      </Section>
    );
  }

  if (!createButton) return null;
  return (
    <Section id="component" title={componentSectionHeader} className="">
      {createButton}
    </Section>
  );
}

