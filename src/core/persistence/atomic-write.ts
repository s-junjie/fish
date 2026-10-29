/** The subset of a `FileSystemWritableFileStream` this app relies on. */
export interface WritableStreamLike {
  write: (s: string) => Promise<void>;
  truncate?: (size: number) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
}

/**
 * Replace an existing file's contents without ever leaving it empty.
 *
 * `createWritable()` defaults `keepExistingData` to false, and that is not a
 * semantic nicety: the file is truncated to zero bytes *before* `write` is
 * called, so a full disk, a revoked permission or a crash mid-write leaves the
 * user with nothing to open — and the original is gone. Keeping the existing
 * data moves the write into a temp file that only replaces the original on
 * `close()`, and `abort()` throws that temp file away with the original intact.
 *
 * Its cost is that `write` never shortens the temp file, so a shorter document
 * written over a longer one would keep the tail of the previous file (a second
 * runtime payload, a second `#app` — a shell that refuses to boot). Hence the
 * explicit cut, in bytes: `truncate` takes a byte count, not a character count.
 * The two options only work as a pair, which is why they live here together.
 */
export async function writeBytesAtomically(handle: unknown, content: string): Promise<void> {
  const createWritable = (
    handle as { createWritable?: (opts?: unknown) => Promise<WritableStreamLike> } | null
  )?.createWritable;
  if (typeof createWritable !== "function") throw new Error("no-writable");
  let stream: WritableStreamLike | undefined;
  try {
    stream = await createWritable.call(handle, { keepExistingData: true });
    await stream.write(content);
    await stream.truncate?.(new TextEncoder().encode(content).byteLength);
    await stream.close();
  } catch (err) {
    // Best effort: abort() only means anything while the temp file is still
    // open, and a close() that threw may already have released it. Never let
    // this mask the original failure.
    try {
      await stream?.abort?.();
    } catch {
      // already closed or aborted
    }
    throw err;
  }
}
