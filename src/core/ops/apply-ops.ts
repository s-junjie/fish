/**
 * The macro-op runtime that `agent-kit/references/workflow.md` §3 describes but the artifact
 * does not ship: the ops were a table an external agent had to carry out by
 * hand-editing JSON. Every branch here calls the same core function the matching
 * UI action calls, so a scripted `patch` and an inspector edit cannot drift
 * apart — which is the whole reason to have a runtime instead of a second
 * implementation.
 */

import type { ComponentElement, DesignDocument, DesignElement } from "../dsl/types";
import { getActivePage, updateActivePageElements } from "../dsl/document-ops";
import { resolveInstanceSelection, type InstanceSelection } from "../interactions/instance-resolve";
import {
  findElementById,
  findParentById,
  insertElementIntoContainer,
  isContainer,
  mapElements,
  removeElementFromTree
} from "../geometry/tree-ops";
import {
  createComponentFromElement,
  createInstanceFromComponent,
  detachInstance,
  resetInstance
} from "../interactions/component-ops";
import { performBooleanOperation, type BooleanOp } from "../geometry/boolean-ops";
import { variantName } from "../interactions/variant-naming";
import { layoutOf } from "../dsl/layout-flat";
import { canonicalKey, pxLength, type NormalizationRepair } from "../dsl/normalize/shared";
import { collectVariables, hasVarCallInValue, resolveValueTokens } from "../dsl/normalize/resolve-values";
import { applyTokenShorthandsToElement, createTokenVarResolver } from "../dsl/normalize/token-shorthand";
import {
  CSS_PATCH_SPELLINGS,
  STRING_LENGTH_AXES,
  hasTokenRef,
  mergeProps,
  normalizePatchedElement,
  parentBoxOf,
  patchDerivedClone,
  preparePatch
} from "./patch-props";
import { REPEAT_IDENT, substituteTemplate } from "./repeat-template";
import { applyComponentIntent } from "./component-intent";
import { absoluteOriginOf, placeElement, wrapInLayout } from "./placement";
import { isObj, mintId, num, str, type OpOutcome } from "./op-primitives";
import { scaleElementGeometry } from "../geometry/scale-geometry";

export type { OpOutcome } from "./op-primitives";

/**
 * Whether anything in a subtree is written in a spelling only the normalizer
 * reads — a CSS alias, or a length as a string.
 *
 * The gate in `insert` used to look at the top level alone, which was enough
 * while every inserted node was a leaf. A frame carries children, and a child
 * using `background` or `padding` was stored verbatim: the frame normalized,
 * its children did not, and the layer landed with a key nothing paints from.
 */
function needsNormalization(el: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(el)) {
    const canon = canonicalKey(key);
    if (CSS_PATCH_SPELLINGS.has(canon)) return true;
    if (STRING_LENGTH_AXES.has(canon) && typeof value === "string") return true;
    if (hasTokenRef(value) || hasVarCallInValue(value)) return true;
  }
  const children = el.children;
  return Array.isArray(children) && children.some((child) => isObj(child) && needsNormalization(child));
}

export interface ApplyOpsResult {
  doc: DesignDocument;
  outcomes: OpOutcome[];
  changed: boolean;
}

/**
 * A path keeps its outline in `d`; `width`/`height` are its bounding box, never a
 * viewBox. The drag and Scale gestures therefore bake the factor into `d`
 * (`geometry-gestures`), and a `patch` that writes only the box has to do the
 * same — otherwise one resize means two different things depending on who asked
 * for it, and the drawing quietly stays at its old size in the corner.
 *
 * An outline written in the same patch wins: that is the author saying what the
 * geometry is, and scaling it too would apply the factor twice.
 */
function scalePatchedPath(before: DesignElement, after: DesignElement, props: Record<string, unknown>): DesignElement {
  if (before.type !== "path" || after.type !== "path") return after;
  const canon = new Set(Object.keys(props).map(canonicalKey));
  if (canon.has("d") || canon.has("path") || canon.has("path-data")) return after;
  if (!canon.has("width") && !canon.has("height")) return after;
  if (!(before.width > 0 && before.height > 0)) return after;
  if (!(after.width > 0 && after.height > 0)) return after;
  return scaleElementGeometry(after, after.width / before.width, after.height / before.height);
}

export function applyOps(doc: DesignDocument, input: unknown): ApplyOpsResult {
  const ops = Array.isArray(input)
    ? input
    : isObj(input) && Array.isArray(input.ops)
      ? input.ops
      : undefined;
  if (!ops) {
    return {
      doc,
      outcomes: [{ index: 0, op: "?", ok: false, detail: "ops must be an array, or { ops: [...] }" }],
      changed: false
    };
  }

  let current = doc;
  const outcomes: OpOutcome[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    const result = applyOne(current, ops[index]);
    current = result.doc;
    outcomes.push({ index, ...result.outcome });
  }
  return { doc: current, outcomes, changed: outcomes.some((o) => o.ok) };
}

function applyOne(doc: DesignDocument, raw: unknown): { doc: DesignDocument; outcome: Omit<OpOutcome, "index"> } {
  if (!isObj(raw)) return { doc, outcome: { op: "?", ok: false, detail: "op must be an object" } };
  const op = str(raw.op);
  if (!op) return { doc, outcome: { op: "?", ok: false, detail: "op is missing its `op` name" } };

  const els = getActivePage(doc).children;
  const commit = (next: DesignElement[]): DesignDocument => updateActivePageElements(doc, next);
  const fail = (detail: string, id?: string): { doc: DesignDocument; outcome: Omit<OpOutcome, "index"> } => ({
    doc,
    outcome: { op, ok: false, detail, id }
  });
  const targetId = str(raw.targetId);
  const needs = (id: string | undefined): DesignElement | null => (id ? findElementById(els, id) : null);
  const target = needs(targetId);
  // A node inside an instance is a resolved clone: painted, never stored, so the
  // id the canvas hands out means nothing to a tree walk. Without this the most
  // common instance edit there is — restyle a label inside a button — is
  // unreachable from a script, while the inspector reaches it by another route.
  const derived: InstanceSelection | null =
    targetId && !target ? resolveInstanceSelection(doc, targetId) : null;
  if (targetId && !target && !derived) return fail(`no element with id "${targetId}"`, targetId);

  // Component ops that are their own verb rather than a patch of fields.
  const componentIntent = applyComponentIntent(doc, op, targetId, raw);
  if (componentIntent) return componentIntent;

  switch (op) {
    case "patch": {
      const props = raw.props;
      if (!isObj(props)) return fail("patch needs `props: { ... }`", targetId);
      if (derived) return patchDerivedClone(doc, derived, props);
      const parent = targetId ? findParentById(els, targetId) : null;
      const parentLayout = parent ? (layoutOf(parent) ?? null) : null;
      const vars = collectVariables(doc.variables);
      // `mergeProps` DEEP-merges, so `{ x: { a: 1 } }` is a delta meaning "keep
      // every other key of x" — which is what makes a nested patch able to touch
      // one variant coordinate without naming the rest.
      //
      // A token reference is resolved against THIS document's table and modes,
      // and a reference that resolves to nothing fails the op: a patch that
      // reports `ok` while its declaration was dropped is a lie the panel then
      // repeats.
      const tokenRepairs: NormalizationRepair[] = [];
      const patched = mapElements(els, (el) => {
        if (el.id !== targetId) return el;
        const prepared = preparePatch(el, props);
        if (!prepared.css) {
          return scalePatchedPath(el, prepared.element as unknown as DesignElement, props);
        }
        return scalePatchedPath(
          el,
          normalizePatchedElement(prepared.element, parentLayout, vars, {
            tokens: doc.tokens,
            modes: doc,
            parentBox: parentBoxOf(parent, parentLayout),
            onRepair: (repair) => tokenRepairs.push(repair)
          }),
          props
        );
      });
      if (tokenRepairs.length > 0) return fail(tokenRepairs[0].message, targetId);
      let next = commit(patched);
      // A variant's NAME is its coordinates, so a patch that moved one has to move
      // the name with it. `mergeProps` knows nothing about that pairing and left
      // the layer reading `State=Default` while the member sat at `State=Hover`.
      if (props.variantProperties && targetId) {
        const merged = findElementById(getActivePage(next).children, targetId);
        if (merged?.type === "component") {
          const coords = (merged as ComponentElement).variantProperties ?? {};
          const renamed = variantName(coords, merged.name ?? "");
          next = updateActivePageElements(
            next,
            mapElements(getActivePage(next).children, (el) =>
              el.id === targetId ? { ...el, name: renamed } : el
            )
          );
        }
      }
      return { doc: next, outcome: { op, ok: true, detail: `patched ${Object.keys(props).join(", ")}`, id: targetId } };
    }

    case "replace": {
      const element = raw.element;
      if (!isObj(element)) return fail("replace needs `element: { ... }`", targetId);
      if (derived) return refuseDerived(doc, op, derived);
      // The replacement is a fresh subtree the normalizer has never seen, so it
      // takes the same fold `insert` takes: a CSS-spelled body ("color",
      // "background", flat layout keys) arrives as ink and layout instead of
      // dead stored keys the audit reads as "content but no ink".
      const parent = targetId ? findParentById(els, targetId) : null;
      const parentLayout = parent ? (layoutOf(parent) ?? null) : null;
      const vars = collectVariables(doc.variables);
      const tokenRepairs: NormalizationRepair[] = [];
      const replacement = normalizePatchedElement({ ...element, id: targetId }, parentLayout, vars, {
        tokens: doc.tokens,
        modes: doc,
        parentBox: parentBoxOf(parent, parentLayout),
        onRepair: (repair) => tokenRepairs.push(repair)
      });
      if (tokenRepairs.length > 0) return fail(tokenRepairs[0].message, targetId);
      const next = commit(mapElements(els, (el) => (el.id === targetId ? replacement : el)));
      return { doc: next, outcome: { op, ok: true, detail: "subtree replaced (id kept)", id: targetId } };
    }

    case "remove": {
      const ids = Array.isArray(raw.targetIds) ? raw.targetIds.filter((v): v is string => typeof v === "string") : targetId ? [targetId] : [];
      if (ids.length === 0) return fail("remove needs `targetIds: [...]`");
      let list = els;
      const removed: string[] = [];
      for (const id of ids) {
        const [nextList, gone] = removeElementFromTree(list, id);
        if (gone) removed.push(id);
        list = nextList;
      }
      const missing = ids.filter((id) => !removed.includes(id));
      const unreachable = missing
        .map((id) => resolveInstanceSelection(doc, id))
        .filter((n): n is InstanceSelection => Boolean(n));
      if (unreachable.length > 0) {
        // Partially applied on purpose, matching the branch below: the removals
        // that resolved are gone, and returning the untouched document instead
        // would discard work the caller has no other record of having happened.
        const named = unreachable.map((s) => s.node.id).join(", ");
        const master = unreachable[0].master.id;
        return {
          doc: commit(list),
          outcome: {
            op,
            ok: false,
            detail: `${removed.length > 0 ? `removed ${removed.join(", ")}; ` : ""}${named} ${unreachable.length === 1 ? "is" : "are"} inside instance "${unreachable[0].instanceId}", painted but never stored — remove cannot reach ${unreachable.length === 1 ? "it" : "them"}; edit master "${master}"`,
            id: unreachable[0].node.id
          }
        };
      }
      return {
        doc: commit(list),
        outcome: {
          op,
          ok: removed.length > 0,
          detail: missing.length > 0 ? `removed ${removed.join(", ")}; not found: ${missing.join(", ")}` : `removed ${removed.join(", ")}`
        }
      };
    }

    case "insert": {
      const element = raw.element;
      if (!isObj(element)) return fail("insert needs `element: { ... }`");
      const id = str(element.id) ?? mintId("el");
      const parentId = str(raw.parentId);
      const parent = parentId ? findElementById(els, parentId) : null;
      if (parentId && !parent) {
        const parentDerived = resolveInstanceSelection(doc, parentId);
        return parentDerived
          ? refuseDerived(doc, op, parentDerived)
          : fail(`no element with id "${parentId}"`, parentId);
      }
      if (parent && !isContainer(parent)) {
        // Silently dropping the child is the worst outcome here: the op reports
        // success and the element is nowhere in the document.
        return fail(`"${parentId}" is a ${parent.type}; only a frame / component can take children`, parentId);
      }
      const vars = collectVariables(doc.variables);
      const baseEl = { ...element, id };
      // Tokens are lowered BEFORE placement: a `$ref` or `var(--name)` in
      // `padding` or `gap` is a number once it is resolved, and placing a box
      // against a literal "$x" is how the element ends up at the wrong coordinate.
      const tokenRepairs: NormalizationRepair[] = [];
      const withTokens = applyTokenShorthandsToElement(baseEl, doc.tokens, doc, "/insert", tokenRepairs, vars);
      if (tokenRepairs.length > 0) return fail(tokenRepairs[0].message, id);
      const resolved = resolveValueTokens(withTokens, vars, createTokenVarResolver(doc.tokens, doc));
      if (resolved.unresolved.length > 0) {
        return fail(`"${resolved.unresolved[0].text}": no custom property (define it in "variables" or add a fallback)`, id);
      }
      const resolvedEl = resolved.value as Record<string, unknown>;
      const rawPlaced = placeElement(els, resolvedEl as unknown as DesignElement, raw.position, parentId);
      if (!rawPlaced) return fail(`insert: no container with id "${parentId}"`, parentId);
      const parentLayout = parent ? (layoutOf(parent) ?? null) : null;
      const hasCss = needsNormalization(rawPlaced as unknown as Record<string, unknown>);
      // An element that named a token is normalized even when it spells no CSS
      // key: the shapes this pass writes (`fills`, `tokenBindings`) still have to
      // go through the reader that gives them sizing and a type.
      const placed = hasCss || withTokens !== baseEl || resolved.value !== withTokens
        ? normalizePatchedElement(rawPlaced as unknown as Record<string, unknown>, parentLayout, vars, {
            tokens: doc.tokens,
            modes: doc,
            parentBox: parentBoxOf(parent, parentLayout),
            onRepair: (repair) => tokenRepairs.push(repair)
          })
        : rawPlaced;
      if (tokenRepairs.length > 0) return fail(tokenRepairs[0].message, id);
      const withChild = parentId
        ? commit(mapElements(els, (el) => (el.id === parentId && isContainer(el) ? { ...el, children: [...(el.children ?? []), placed] } as DesignElement : el)))
        : commit([...els, placed]);
      return { doc: withChild, outcome: { op, ok: true, detail: parentId ? `inserted into ${parentId}` : "inserted at canvas level", id } };
    }

    case "repeat": {
      const template = raw.template;
      if (!isObj(template)) return fail("repeat needs `template: { ... }`");

      // Exactly one selector: `over` (a caller-computed list) or `count` (sugar
      // for an index list). Both or neither is a guess, and this op refuses to.
      const hasOver = Array.isArray(raw.over);
      const hasCount = raw.count !== undefined;
      if (hasOver === hasCount) {
        return fail(`repeat needs exactly one of \`over: [...]\` or \`count: N\`${hasOver ? " (both were given)" : " (neither was given)"}`);
      }
      let entries: unknown[];
      if (hasOver) {
        entries = raw.over as unknown[];
      } else {
        const count = num(raw.count);
        if (count === undefined || !Number.isInteger(count) || count < 0) {
          return fail("repeat `count` must be a non-negative integer");
        }
        entries = Array.from({ length: count }, (_, i) => i);
      }

      const as = str(raw.as) ?? "item";
      if (as === "i" || !REPEAT_IDENT.test(as)) {
        return fail(`repeat \`as\` must be an identifier other than the reserved "i" (got "${as}")`);
      }

      // `position` is an OPTIONAL offset added to each item's substituted x/y — a
      // single override is meaningless for N items. A string position is refused.
      const repeatPosition = raw.position;
      if (repeatPosition !== undefined && !isObj(repeatPosition)) {
        return fail("repeat `position` must be an { x, y } offset object");
      }
      const offsetX = isObj(repeatPosition) ? pxLength(repeatPosition.x) ?? 0 : 0;
      const offsetY = isObj(repeatPosition) ? pxLength(repeatPosition.y) ?? 0 : 0;

      // Parenting matches `insert`: a non-container or a missing parent is named
      // and refused, and a node inside an instance is shown the way out.
      const repeatParentId = str(raw.parentId);
      const repeatParent = repeatParentId ? findElementById(els, repeatParentId) : null;
      if (repeatParentId && !repeatParent) {
        const parentDerived = resolveInstanceSelection(doc, repeatParentId);
        return parentDerived
          ? refuseDerived(doc, op, parentDerived)
          : fail(`no element with id "${repeatParentId}"`, repeatParentId);
      }
      if (repeatParent && !isContainer(repeatParent)) {
        return fail(`"${repeatParentId}" is a ${repeatParent.type}; only a frame / component can take children`, repeatParentId);
      }

      // Substitute and validate EVERY entry before placing ANY — the batch is
      // atomic, so a failure on entry 7 does not leave entries 0..6 behind.
      const idsSeen = new Set<string>();
      const prepared: DesignElement[] = [];
      for (let i = 0; i < entries.length; i += 1) {
        let substituted: unknown;
        try {
          substituted = substituteTemplate(template, { index: i, entry: entries[i], as });
        } catch (err) {
          return fail(`repeat entry ${i}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!isObj(substituted)) return fail(`repeat entry ${i}: template did not expand to an object`);
        const explicitId = str(substituted.id);
        const id = explicitId ?? mintId("el");
        if (explicitId) {
          if (idsSeen.has(id)) {
            return fail(`repeat: id "${id}" repeats within the batch — give the template a unique id such as "x_$i"`);
          }
          idsSeen.add(id);
        }
        prepared.push({ ...substituted, id } as unknown as DesignElement);
      }

      const placed: DesignElement[] = [];
      for (const element of prepared) {
        const x = (pxLength((element as { x?: unknown }).x) ?? 0) + offsetX;
        const y = (pxLength((element as { y?: unknown }).y) ?? 0) + offsetY;
        const placedOne = placeElement(els, { ...element, x, y } as DesignElement, repeatParentId ? { x, y } : undefined, repeatParentId);
        if (!placedOne) return fail(`repeat: no container with id "${repeatParentId}"`, repeatParentId);
        placed.push(placedOne);
      }

      const withRepeats = repeatParentId
        ? commit(mapElements(els, (el) => (el.id === repeatParentId && isContainer(el) ? { ...el, children: [...(el.children ?? []), ...placed] } as DesignElement : el)))
        : commit([...els, ...placed]);
      return {
        doc: withRepeats,
        outcome: {
          op,
          ok: true,
          detail: repeatParentId ? `repeated ${placed.length} element(s) into ${repeatParentId}` : `repeated ${placed.length} element(s) at canvas level`,
          id: placed[0]?.id
        }
      };
    }

    case "make-component": {
      // Delegated rather than re-implemented: a non-frame has to be wrapped
      // first, and the id of the resulting component is not the id passed in.
      const created = createComponentFromElement(doc, targetId as string);
      if (!created.component) {
        return fail(
          `"${targetId}" cannot become a component (already one, or a node derived from one, or nested inside one)`,
          targetId
        );
      }
      let next = created.doc;
      const patches: Record<string, unknown> = {};
      if (str(raw.name)) patches.name = raw.name;
      if (Object.keys(patches).length > 0) {
        next = updateActivePageElements(
          next,
          mapElements(getActivePage(next).children, (el) =>
            el.id === created.component!.id ? (mergeProps(el as unknown as Record<string, unknown>, patches) as unknown as DesignElement) : el
          )
        );
      }
      return {
        doc: next,
        outcome: {
          op,
          ok: true,
          detail: created.component.id === targetId ? "promoted to component" : "wrapped in a frame and promoted — the component has a new id",
          id: created.component.id
        }
      };
    }

    case "instantiate": {
      const componentId = str(raw.componentId);
      if (!componentId) return fail("instantiate needs `componentId`");
      const position = isObj(raw.position) ? { x: num(raw.position.x) ?? 0, y: num(raw.position.y) ?? 0 } : undefined;
      const created = createInstanceFromComponent(doc, componentId, position);
      if (!created.instance) return fail(`no component with id "${componentId}" (a master is a node with type:"component")`, componentId);
      let next = created.doc;
      const id = created.instance.id;
      const parentId = str(raw.parentId);
      if (parentId) {
        const parent = findElementById(getActivePage(next).children, parentId);
        if (!parent || !isContainer(parent)) {
          return { doc: next, outcome: { op, ok: true, detail: `instantiated at canvas level; "${parentId}" cannot take children`, id } };
        }
        const list = getActivePage(next).children;
        const [stripped, moved] = removeElementFromTree(list, id);
        const parentAbs = absoluteOriginOf(stripped, parentId);
        // No `origin` in this guard: `lib.dom` declares a global `origin` (the
        // page's origin STRING), so it type-checked while meaning nothing here —
        // truthy in a browser, and a ReferenceError outside one, which is how
        // `instantiate` + `parentId` ended up untested and untestable.
        if (!moved || !parentAbs) return { doc: next, outcome: { op, ok: true, detail: `instantiated at canvas level; could not move into ${parentId}`, id } };
        const local = { ...moved, x: moved.x - parentAbs.x, y: moved.y - parentAbs.y } as DesignElement;
        next = updateActivePageElements(next, insertElementIntoContainer(stripped, local, parentId));
      }
      return { doc: next, outcome: { op, ok: true, detail: `instantiated ${componentId}`, id } };
    }

    case "reset-instance": {
      if (!target) return fail("reset-instance needs `targetId`");
      if (target.type !== "instance") return fail(`"${targetId}" is a ${target.type}, not an instance`, targetId);
      // Delegated, not re-spelled: this branch used to clear `overrides` and the
      // box flag by hand and left the instance's own paint, mode and scale
      // fields behind, so a scripted reset came back to a master that still had
      // the user's fill on it. `resetInstance` is the list the UI's Reset uses.
      const cleared = resetInstance(doc, targetId as string);
      if (!cleared) {
        return { doc, outcome: { op, ok: true, detail: "nothing to reset — the instance already reads as its master", id: targetId } };
      }
      return { doc: cleared, outcome: { op, ok: true, detail: "overrides cleared", id: targetId } };
    }

    case "detach-instance": {
      if (!target) return fail("detach-instance needs `targetId`");
      if (target.type !== "instance") return fail(`"${targetId}" is a ${target.type}, not an instance`, targetId);
      const detached = detachInstance(doc, targetId as string);
      if (!detached.frame) return fail(`detach failed: no master for "${targetId}"`, targetId);
      return { doc: detached.doc, outcome: { op, ok: true, detail: "instance expanded into a frame", id: detached.frame.id } };
    }

    case "intent": {
      const intent = str(raw.intent);
      const ids = Array.isArray(raw.targetIds) ? raw.targetIds.filter((v): v is string => typeof v === "string") : [];
      if (ids.length === 0) return fail("intent needs `targetIds: [...]`");
      if (intent !== "wrap-in-stack" && intent !== "wrap-in-grid") {
        return fail(`intent "${intent ?? "(none)"}" is not applied by this tool; wrap-in-stack and wrap-in-grid are`);
      }
      const wrappedId = ids.map((id) => resolveInstanceSelection(doc, id)).find((s): s is InstanceSelection => Boolean(s));
      if (wrappedId) return refuseDerived(doc, op, wrappedId);
      const wrapped = wrapInLayout(els, ids, intent === "wrap-in-grid", isObj(raw.params) ? raw.params : {});
      if (!wrapped) return fail("wrap needs every target to share one parent", ids[0]);
      return { doc: commit(wrapped.els), outcome: { op, ok: true, detail: `wrapped ${ids.length} element(s) in a ${intent === "wrap-in-grid" ? "grid" : "flex"} frame`, id: wrapped.id } };
    }

    case "boolean": {
      const ids = Array.isArray(raw.targetIds) ? raw.targetIds.filter((v): v is string => typeof v === "string") : [];
      if (ids.length < 2) return fail("boolean needs `targetIds: [id, id]` — at least two shapes");
      const intent = str(raw.intent) ?? str(raw.operation);
      if (!intent || !BOOLEAN_OPS.includes(intent as BooleanOp)) {
        return fail(`boolean needs \`intent\` (or \`operation\`) of ${BOOLEAN_OPS.join(" | ")}`, ids[0]);
      }
      // The engine's `performBooleanOperation` walks the active page's TOP-LEVEL
      // children only, so a nested id would be silently dropped and the op would
      // report a shape that never combined. Naming the reason beats that.
      const topLevel = ids.filter((id) => els.some((el) => el.id === id));
      const derived = ids
        .filter((id) => !topLevel.includes(id))
        .map((id) => resolveInstanceSelection(doc, id))
        .filter((s): s is InstanceSelection => Boolean(s));
      if (derived.length > 0) return refuseDerived(doc, op, derived[0]);
      const unknown = ids.filter((id) => !topLevel.includes(id) && !findElementById(els, id));
      if (unknown.length > 0) return fail(`no element with id "${unknown.join('", "')}"`, unknown[0]);
      if (topLevel.length < 2) {
        const nested = ids.filter((id) => !topLevel.includes(id));
        return fail(
          `boolean works on top-level shapes; ${nested.join(", ")} ${nested.length === 1 ? "is nested inside a frame" : "are nested inside frames"} — move ${nested.length === 1 ? "it" : "them"} to the canvas first`,
          nested[0]
        );
      }
      const { doc: next, newElementId } = performBooleanOperation(doc, new Set(topLevel), intent as BooleanOp);
      if (!newElementId) {
        // Frames, text, groups and instances draw no outline, so they have no ring
        // to combine — the core returns null rather than an empty path.
        return fail(`boolean ${intent} produced nothing: it needs at least two shapes that draw an outline (rect / ellipse / polygon / star / path)`, topLevel[0]);
      }
      return { doc: next, outcome: { op, ok: true, detail: `${intent} of ${topLevel.length} shapes`, id: newElementId } };
    }

    default:
      return fail(`unknown op "${op}"`);
  }
}

const BOOLEAN_OPS: BooleanOp[] = ["union", "subtract", "intersect", "exclude"];

/**
 * Turns away an op that would rewrite the tree through a node that is not in it.
 *
 * `replace` is the reason this has to exist rather than a nicety: it maps over
 * the element list, so a derived id changes nothing and it still answers ok —
 * and the caller has no way to learn the edit landed nowhere.
 */
function refuseDerived(
  doc: DesignDocument,
  op: string,
  sel: InstanceSelection
): { doc: DesignDocument; outcome: Omit<OpOutcome, "index"> } {
  const id = sel.node.id;
  return {
    doc,
    outcome: {
      op,
      ok: false,
      detail: `"${id}" is a node inside instance "${sel.instanceId}", which is painted but never stored — ${op} cannot reach it; edit master "${sel.master.id}" or the instance itself`,
      id
    }
  };
}
