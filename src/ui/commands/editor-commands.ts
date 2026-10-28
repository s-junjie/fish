/**
 * A registry of named editor commands, so a command has one implementation and
 * two ways in.
 *
 * The clipboard commands live inside `useShortcuts` (they own the file clipboard
 * and the undo boundaries), and the context menu needs exactly those commands.
 * Threading them down as props would mean a menu that can drift from the keyboard
 * — the two lists of "what Copy does" are then maintained separately and one of
 * them rots. Registering by id keeps a single owner per command.
 */
export interface EditorCommandSpec {
  /**
   * @param arg What the caller knows and the selection does not.
   *
   * Almost every command needs none, and that is why it is optional. The ones
   * that do name a node the caller was already holding — the collapse twisty on a
   * component set's title knows which set it was drawn for, and reading the
   * selection instead would toggle whatever happened to be selected.
   */
  run: (arg?: any) => void;
  /** Defaults to true; a command that cannot run now reports false and greys out. */
  enabled?: () => boolean;
}

const registry = new Map<string, EditorCommandSpec>();

/** Returns an unregister function, for a hook effect to call on cleanup. */
export function registerEditorCommand(id: string, spec: EditorCommandSpec): () => void {
  registry.set(id, spec);
  return () => {
    if (registry.get(id) === spec) registry.delete(id);
  };
}

export function runEditorCommand(id: string, arg?: any): boolean {
  const spec = registry.get(id);
  if (!spec) return false;
  if (spec.enabled && !spec.enabled()) return false;
  spec.run(arg);
  return true;
}

export function editorCommandEnabled(id: string): boolean {
  const spec = registry.get(id);
  if (!spec) return false;
  return spec.enabled ? spec.enabled() : true;
}
