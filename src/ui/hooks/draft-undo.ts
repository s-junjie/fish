/**
 * Registry for modal draft editors (Token / Style popovers) that keep edits in
 * local state until Save. While one is open, ⌘Z / ⇧⌘Z / ⌘Y routes to the top
 * editor's draft history instead of leaking to the document underneath.
 */
export interface DraftUndoHandler {
  undo: () => boolean;
  redo: () => boolean;
}

const stack: DraftUndoHandler[] = [];

export function registerDraftUndo(handler: DraftUndoHandler): () => void {
  stack.push(handler);
  return () => {
    const idx = stack.lastIndexOf(handler);
    if (idx !== -1) stack.splice(idx, 1);
  };
}

export function hasDraftUndo(): boolean {
  return stack.length > 0;
}

export function runDraftUndo(isRedo: boolean): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  if (isRedo) top.redo();
  else top.undo();
  return true;
}
