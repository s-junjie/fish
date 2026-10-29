import {
  DesignDocument,
  DesignElement,
  Page,
  Paint,
  getActivePage,
  updateActivePage,
  updateActivePageElements,
  adoptTopLevelElements
} from "../dsl/types";
import { relayoutDocumentTree } from "../compile";
import { setAmbientChildSizeResolver } from "../layout/context";
import { measureSpan } from "../perf";
import { instanceSizeResolver } from "../interactions/instance-size";
import { propagateMasterSize } from "../interactions/instance-inherit";
import { deepEqual } from "../deep-equal";

export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Why the editor is showing a document it may not write.
 *
 * `history-preview` — the version panel is open, and possibly showing a version
 * in place of the live document. `shared-file` — a document handed over read-only;
 * the same pair with the view left alone. Both are viewer states, never stored:
 * reopening the file has to leave it editable.
 */
export type ReadOnlyReason = "history-preview" | "shared-file";

export interface EditorCommand {
  type: string;
  patch: (doc: DesignDocument) => DesignDocument;
  /**
   * Whether this command records an undo snapshot.
   * Defaults to true. Set false during continuous gestures / scrubbing.
   */
  recordHistory?: boolean;
}

export interface MutateElementsOptions {
  recordHistory?: boolean;
  relayout?: boolean;
}

export class EditorStore {
  private doc: DesignDocument;
  private past: DesignDocument[] = [];
  private future: DesignDocument[] = [];
  private gestureInitialDoc: DesignDocument | null = null;
  private listeners = new Set<(doc: DesignDocument) => void>();
  private historyListeners = new Set<(doc: DesignDocument) => void>();
  private gestureListeners = new Set<() => void>();
  /** What the UI renders instead of the live document, when it is not the live one. */
  private viewDoc: DesignDocument | null = null;
  private readOnlyReason: ReadOnlyReason | null = null;
  private viewListeners = new Set<() => void>();
  private readonly historyLimit: number;

  constructor(initialDoc: DesignDocument, historyLimit = DEFAULT_HISTORY_LIMIT) {
    this.doc = adoptTopLevelElements(initialDoc);
    this.historyLimit = historyLimit;
    this.publishChildSizeResolver();
  }

  /**
   * Republishes the resolver every layout pass reads when it was not handed one.
   *
   * The 24 call sites outside the two tree passes — the auto-layout inspector
   * section, the canvas gestures, `stack-resize` — cannot build one: the masters
   * live on the document, and only the store holds it. Publishing it here rather
   * than threading it through each of them is what keeps a hugging instance from
   * being measured by its authored width on the inspector path.
   *
   * After the assignment, not before: the passes that needed a resolver have
   * already run by the time a commit lands, and what they must see next is the
   * document that commit produced.
   *
   * It publishes whatever is on screen: while a version is being viewed, an
   * instance measured against the live masters would hug to a width the canvas
   * is not drawing.
   */
  private publishChildSizeResolver(): void {
    setAmbientChildSizeResolver(instanceSizeResolver(this.getViewDoc()));
  }

  getDoc(): DesignDocument {
    return this.doc;
  }

  /** What to render. Equals `getDoc()` unless a viewer state redirected it. */
  getViewDoc(): DesignDocument {
    return this.viewDoc ?? this.doc;
  }

  /** Writes are refused for as long as this holds, view redirect or not. */
  isReadOnly(): boolean {
    return this.readOnlyReason !== null || this.viewDoc !== null;
  }

  getReadOnlyReason(): ReadOnlyReason | null {
    return this.readOnlyReason;
  }

  /**
   * Fires when what the UI renders, or whether it may write, changes — and
   * never on an edit. `notify()` is auto-save's flush signal, so a viewer state
   * has to reach the UI by a channel that cannot be mistaken for one: that is
   * the whole reason browsing a version mints no version of its own.
   */
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  private notifyView() {
    for (const listener of this.viewListeners) listener();
  }

  setReadOnly(reason: ReadOnlyReason | null): void {
    if (this.readOnlyReason === reason) return;
    this.readOnlyReason = reason;
    this.notifyView();
  }

  /** Redirects the rendered document. Passing `null` returns to the live one. */
  setViewDoc(doc: DesignDocument | null): void {
    if (this.viewDoc === doc) return;
    this.viewDoc = doc;
    this.publishChildSizeResolver();
    this.notifyView();
  }

  /**
   * The single condition under which the document may not change.
   *
   * Both halves count: a view that is not the live document must never be
   * written through the object the live one is reachable by, and a read-only
   * reason must hold even while the view still shows the live document (the
   * panel open, no version selected). Checked in every entry that touches
   * `this.doc` rather than audited at the ~60 call sites that reach them —
   * a future one cannot forget to be careful.
   */
  private writesRefused(): boolean {
    return this.readOnlyReason !== null || this.viewDoc !== null;
  }

  getActivePage(): Page {
    return getActivePage(this.doc);
  }

  subscribe(listener: (doc: DesignDocument) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Fires on every *recording* history boundary (a recording commit or a
   * completed gesture). This is the signal the version timeline listens to: it
   * represents one logical user operation, not every transient frame.
   */
  onHistory(listener: (doc: DesignDocument) => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.doc);
    }
  }

  private notifyHistory() {
    for (const listener of this.historyListeners) {
      listener(this.doc);
    }
  }

  /**
   * Whether an interactive gesture is open.
   *
   * A drag frame is not a state a background job should chase: work that a
   * gesture will invalidate a frame later (the cover thumbnail) has to wait for
   * the gesture to close, not for the document to hold still for a moment.
   */
  isGestureActive(): boolean {
    return this.gestureInitialDoc !== null;
  }

  /** Fires when a gesture opens or closes, never on a frame within one. */
  onGestureChange(listener: () => void): () => void {
    this.gestureListeners.add(listener);
    return () => this.gestureListeners.delete(listener);
  }

  private notifyGesture() {
    for (const listener of this.gestureListeners) listener();
  }

  /**
   * Marks the beginning of an interactive gesture (drag, scrub, slider).
   * Freezes a snapshot of the current document for undo consolidation.
   */
  startGesture() {
    if (this.writesRefused()) return;
    if (!this.gestureInitialDoc) {
      this.gestureInitialDoc = this.doc;
      this.notifyGesture();
    }
  }

  /**
   * Ends an interactive gesture. Compares current doc to the initial snapshot.
   * If changed, records exactly ONE undo step.
   */
  endGesture() {
    if (this.writesRefused()) {
      const had = this.gestureInitialDoc !== null;
      this.gestureInitialDoc = null;
      if (had) this.notifyGesture();
      return;
    }
    const initial = this.gestureInitialDoc;
    if (!initial) return;
    this.gestureInitialDoc = null;
    this.notifyGesture();
    if (!deepEqual(initial, this.doc)) {
      this.past.push(initial);
      if (this.past.length > this.historyLimit) this.past.shift();
      this.future = [];
      this.notifyHistory();
    }
  }

  /**
   * Cancels an active gesture and rolls document back to gestureInitialDoc.
   */
  cancelGesture() {
    if (this.writesRefused()) {
      const had = this.gestureInitialDoc !== null;
      this.gestureInitialDoc = null;
      if (had) this.notifyGesture();
      return;
    }
    const initial = this.gestureInitialDoc;
    this.gestureInitialDoc = null;
    if (initial) {
      this.doc = initial;
      this.notify();
    }
    if (initial) this.notifyGesture();
  }

  /**
   * Primary choke point for modifying document state.
   */
  dispatch(command: EditorCommand) {
    const nextDoc = command.patch(this.doc);
    this.commit(nextDoc, { skipHistory: command.recordHistory === false });
  }

  /**
   * Commits a document state, writing the active page's tree through `pages` only.
   *
   * A commit that lands the document it already holds records no step, matching
   * `endGesture`. The two used to disagree, and the callers that close a gesture
   * by committing the *current* document (`onCommitSnapshot(docRef.current)`, the
   * inspector's scrub-end) relied on the disagreement not to matter: a scrub that
   * ended where it started pushed an entry identical to the live document, so the
   * user's first ⌘Z undid nothing visible.
   */
  commit(newDoc: DesignDocument, options?: { skipHistory?: boolean }) {
    if (this.writesRefused()) return;
    measureSpan("fish.commit", () => {
      // Every write in the app funnels through here, which is what lets a
      // master's new size reach its instances: `propagateMasterSize` compares the
      // incoming state with the one it replaces, so a gesture frame (a transient
      // commit of its own) propagates exactly as a discrete edit does.
      const synced = adoptTopLevelElements(propagateMasterSize(this.doc, newDoc));
      if (!options?.skipHistory && !deepEqual(synced, this.doc)) {
        // A recording commit supersedes any gesture frozen earlier — otherwise a
        // stale snapshot would swallow unrelated changes into one giant undo.
        this.gestureInitialDoc = null;
        this.past.push(this.doc);
        if (this.past.length > this.historyLimit) this.past.shift();
        this.future = [];
        this.notifyHistory();
      }
      this.doc = synced;
      this.publishChildSizeResolver();
    });
    this.notify();
  }

  /**
   * Commits `nextDoc` as part of an open gesture (drag frames used setTransient,
   * so this records exactly ONE undo step vs the gesture start). Falls back to
   * a plain recording commit when no gesture is open.
   */
  commitAndEndGesture(nextDoc: DesignDocument) {
    if (this.gestureInitialDoc) {
      this.setTransient(nextDoc);
      this.endGesture();
    } else {
      this.commit(nextDoc);
    }
  }

  /**
   * Transient update without pushing history (e.g. during a continuous gesture frame).
   */
  setTransient(newDoc: DesignDocument) {
    this.commit(newDoc, { skipHistory: true });
  }

  /**
   * Announce a change that lives in the file but not in the document.
   *
   * Comments are stored in their own `#fish-comments` block precisely so they
   * never touch `#design-doc` — which also means no commit happens when one is
   * written, and auto-save (which subscribes to commits) never learns that the
   * file is now stale. The comment store calls this after every mutation so the
   * writer runs; the document itself is untouched, so no undo step is recorded
   * and the UI's own subscribers see the same document identity.
   */
  touch() {
    this.notify();
  }

  /**
   * Updates elements of the active page.
   */
  updateActivePageElements(
    elements: DesignElement[],
    options?: MutateElementsOptions
  ) {
    // Resolved against the CURRENT document, so a master on another page is found
    // and a hugging instance is measured by what it paints.
    const finalElements =
      options?.relayout !== false
        ? relayoutDocumentTree(elements, instanceSizeResolver(this.doc))
        : elements;
    const nextDoc = updateActivePageElements(this.doc, finalElements);
    this.commit(nextDoc, { skipHistory: options?.recordHistory === false });
  }

  /**
   * Scoped update for active page attributes (e.g. page background, name, canvas size).
   */
  updateActivePage(
    updater: (page: Page) => Partial<Page>,
    options?: { recordHistory?: boolean }
  ) {
    const nextDoc = updateActivePage(this.doc, updater);
    this.commit(nextDoc, { skipHistory: options?.recordHistory === false });
  }

  /**
   * Page-scoped canvas background update with clean undo semantics.
   */
  setPageBackground(background: Paint, options?: { recordHistory?: boolean }) {
    this.updateActivePage(
      (p) => ({
        canvas: { ...p.canvas, background }
      }),
      options
    );
  }

  undo(): boolean {
    // Refused rather than skipped-with-a-stale-view: while a version is on
    // screen an undo would move the document the user cannot see.
    if (this.writesRefused()) return false;
    if (this.past.length === 0) return false;
    const previous = this.past.pop()!;
    this.future.push(this.doc);
    this.doc = previous;
    this.notify();
    return true;
  }

  redo(): boolean {
    if (this.writesRefused()) return false;
    if (this.future.length === 0) return false;
    const next = this.future.pop()!;
    this.past.push(this.doc);
    this.doc = next;
    this.notify();
    return true;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  getPastCount(): number {
    return this.past.length;
  }

  getFutureCount(): number {
    return this.future.length;
  }
}
