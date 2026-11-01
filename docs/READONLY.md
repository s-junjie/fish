# Read-only documents

**Status:** shipped. A saved copy can be locked to viewing, and the lock travels
with the file.

A review copy is a file you send someone. It opens, it is looked at, it is not
edited — because the person who receives it is checking a layout, not taking over
the work. Everything below follows from that.

---

## 1. The rules

**R1 — The policy is a property of the file, not of the session.**

A query string is a request and a viewport is a guess; neither survives being
mailed. The flag is stamped into the shell as
`<meta name="fish:policy" content="read-only">`, next to `fish:fileId`, and is
read once at boot from the live DOM — never scanned out of HTML text, because the
inlined bundle carries the tag's literal spelling in its own source (the same trap
`file-identity.ts` documents).

**R2 — A read-only file opens in the reader, on every device.**

`resolveViewMode` answers `viewer` before it consults width or pointer type: the
reader is the only shell with no write path, and a disabled editor reads as a
broken one. `?view=editor` cannot arm an editor the file has decided against;
`?view=canvas` still works, because an embed never had one.

**R3 — Phones and read-only files want the same shell, for different reasons.**

The device rule stays exactly as `docs/MOBILE.md` states it. Read-only is not a
fourth shell and not a second mobile mode — it is a second reason to arrive at the
same one. That is the whole of the combination: one shell, two doors.

**R4 — The door out is replaced, not merely disabled.**

The reader's top-right pill becomes a `Read only` label. A control that navigates
to a refused reload promises something the file has already denied.

**R5 — Two locks, because one is a shell.**

The reader never renders an editing surface, and the store is put into
`shared-file` read-only at boot, so a stray shortcut, a restored gesture or a
plugin call cannot reach the document either. `writesRefused()` is the gate the
editor already enforces for history preview — this reuses it rather than adding a
second notion of "may not write".

**R6 — A copy is not a target.**

`Save Read-Only Copy…` writes a new file with a fresh `fish:fileId` and does not
adopt it: the tab keeps editing the original, and the two files do not share a
recovery snapshot, a version timeline or a stored handle.

**R7 — It is an application lock, not rights management.**

The document block lives in the same file as the flag, so anyone who edits the
markup can lift it. It stops a reviewer from saving over a review copy; it does
not stop anyone determined. Say so plainly rather than implying otherwise.

---

## 2. How it is built

```
src/core/persistence/file-policy.ts   readOnlyFromShell / stampFilePolicy   (pure + DOM read)
src/core/persistence/container.ts     serializeSelf({ readOnly })           (stamp on every write)
src/ui/viewer/viewer-mode.ts          readOnly is answered before the device rule
src/ui/viewer/ViewerChrome.tsx        the third pill: link, or label
src/ui/hooks/useFileWriteback.ts      triggerSaveAsReadOnly
src/ui/toolbar/AutosaveBadge.tsx      the menu row
```

- Every writer goes through `serializeSelf`, so the CLI, the agent kit and
  Save As all stamp or clear the flag without knowing about it. Clearing is not a
  no-op: an editor save is a statement that the file is editable, and a stale flag
  could not make it.
- Stamping is idempotent — strip, then write — so re-saving a shell cannot produce
  two answers.
- `readOnlyFromShell()` is read in a `useMemo` and never re-evaluated: the policy
  is what the file said when it opened.

## 3. Verification

- `tests/read-only-file.test.ts` — the stamp, its idempotence, its removal, and
  that a read-only save carries exactly one flag while an ordinary save carries
  none.
- `tests/viewer-mode.test.ts` — a desktop read-only file gets the reader,
  `?view=editor` is refused, `?view=canvas` is kept.
- Manual: save a read-only copy, open it at 1440px, confirm the pill reads
  `Read only`, ⌘S does nothing, and the file on disk is byte-identical afterwards.

## 4. Open questions

1. **Text selection.** The reader is `select-none` (a phone cannot pan and select
   with one finger). A desktop reviewer may want to copy a line. Needs a decision,
   not a tweak.
2. **Comments.** Review is what a read-only copy is for, and pins only exist in
   the editor. Read-only plus comments is the obvious next surface.
3. **Re-locking.** There is no "make this file read-only" in place — only a copy.
   Doing it in place would mean a file that just locked itself out of its own
   editor.
