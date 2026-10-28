/**
 * FISH ID Generator — Tier 0 Collaboration Ready.
 *
 * Requirements:
 * 1. Never positional (never `el_1`, `el_2`).
 * 2. Replica-partitioned: Each browser session/client mints a random 6-character replica token.
 * 3. Monotonically incrementing counter + high-res timestamp: guarantees no collisions between peers.
 * 4. Deleted IDs are NEVER reused.
 */

let replicaId = "";
let counter = 0;

export function getReplicaId(): string {
  if (!replicaId) {

    try {
      const stored = localStorage.getItem("fish_replica_id");
      if (stored && stored.length >= 4) {
        replicaId = stored;
      }
    } catch {
    }
    if (!replicaId) {
      replicaId = Math.random().toString(36).substring(2, 8);
      try {
        localStorage.setItem("fish_replica_id", replicaId);
      } catch {
      }
    }
  }
  return replicaId;
}

export function createId(prefix = "el"): string {
  counter++;
  const time = Date.now().toString(36);
  const rep = getReplicaId();
  return `${prefix}_${rep}_${time}_${counter.toString(36)}`;
}

/**
 * An id a source file already had, made safe to carry into a document.
 *
 * The dialect treats an id as an opaque string, but two things downstream do
 * not: the canvas hands `guide_path_${el.id}` to `getElementById`, and the
 * document is embedded in a `<script>`. `[A-Za-z0-9_-]` is the set both accept,
 * and it is what a Figma `12:34` and an HTML `hero_img` both reduce to.
 */
export function sanitizeElementId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mintDocId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `fish_${time}_${rand}`;
}

/**
 * Identity of the *file*, not of the document inside it. Lives in the shell as
 * `<meta name="fish:fileId">` so it survives even when the document block is
 * corrupt — the whole point: recovery data keyed on the document's own `docId`
 * becomes unreachable exactly when the file cannot be parsed, which is when it
 * is needed most.
 */
export function mintFileId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `file_${time}_${rand}`;
}
