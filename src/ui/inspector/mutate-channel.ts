import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { DesignElement } from "../../core/dsl/types";

/**
 * The inspector's write channel: a section turns an edit into an updater and
 * hands it here, with `discrete` saying whether the edit ends a gesture.
 *
 * `discrete` belongs to the edit's SHAPE, not to the field it sits in: a click
 * on a segmented control, a checkbox, a menu row — one command, one undo step.
 * A value DRAG is not that. `ScrubInput` and `SliderRow` bracket their frames
 * with `onDragStart`/`onDragEnd`, and that bracket is what collapses a drag
 * into one entry: a discrete commit inside it pushes a step per pointermove and
 * then nulls the frozen snapshot, so `endGesture` has nothing left to record.
 * So a scrub's `onChange` must stay non-discrete, and where the same handler
 * serves a drag and a click (a stepper's `+`/`-`, a track's `fr`/`px` toggle)
 * the click is the one that passes `true`.
 *
 * It is a channel, not a command — the updater is an ARGUMENT, not a registered
 * name — which is why it travels through context rather than the command
 * registry: there is no availability predicate to grey a menu item with, and the
 * ~80 call sites are all inline closures. The value is stable for the lifetime of
 * the app (it reads the live document and selection through refs), so consuming
 * it costs a section no re-render.
 */
export type MutateSelected = (
  updater: (el: DesignElement) => DesignElement,
  discrete?: boolean
) => void;

const outsideProvider = (): never => {
  throw new Error("[fish] useMutate() called outside the editor's mutate provider");
};

export const MutateContext = createContext<MutateSelected>(outsideProvider);

export function useMutate(): MutateSelected {
  return useContext(MutateContext);
}
