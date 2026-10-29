let currentFileHandle: any = null;

/** Read the active FSA handle (null until the user saves or restores one). */
export function getFileHandle(): any {
  return currentFileHandle;
}

/** Set the active FSA handle (used by the auto-save layer to restore it). */
export function setFileHandle(handle: any): void {
  currentFileHandle = handle;
}

export function clearFileHandle(): void {
  currentFileHandle = null;
}

