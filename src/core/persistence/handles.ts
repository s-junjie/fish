import type { KVBackend } from "./backend";

export interface FileSystemFileHandleLike {
  queryPermission?: (opts?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (opts?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  createWritable?: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
  name?: string;
}

export interface HandleStore {
  save(docId: string, handle: FileSystemFileHandleLike): Promise<void>;
  load(docId: string): Promise<FileSystemFileHandleLike | undefined>;
  clear(docId: string): Promise<void>;
}

interface HandleRow {
  key: string;
  handle: FileSystemFileHandleLike;
}

class KVHandleStore implements HandleStore {
  constructor(private backend: KVBackend) {}

  async save(docId: string, handle: FileSystemFileHandleLike): Promise<void> {
    await this.backend.put("handles", { key: docId, handle } satisfies HandleRow);
  }

  async load(docId: string): Promise<FileSystemFileHandleLike | undefined> {
    const row = (await this.backend.get("handles", docId)) as HandleRow | undefined;
    return row?.handle;
  }

  clear(docId: string): Promise<void> {
    return this.backend.delete("handles", docId);
  }
}

export function createHandleStore(backend: KVBackend): HandleStore {
  return new KVHandleStore(backend);
}
