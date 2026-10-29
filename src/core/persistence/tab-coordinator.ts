export interface TabMessage {
  kind: "hello" | "alive";
  fileId: string;
  tabId: string;
  /**
   * Whether the sending tab is on screen. A message from an older build has no
   * such field; it reads as visible, which only ever makes this tab stand down
   * — the safe direction when the answer is unknown.
   */
  visible: boolean;
}

export interface TabChannel {
  post(msg: TabMessage): void;
  subscribe(cb: (msg: TabMessage) => void): () => void;
  close(): void;
}

export interface TabCoordinatorOptions {
  fileId: string;
  tabId: string;
  /** Another tab owns this file: stop writing back to it. */
  onSuperseded: (byTabId: string) => void;
  /** That tab is gone, or it is no longer on screen; this one may write. */
  onRegained: () => void;
  aliveMs?: number;
  timeoutMs?: number;
  /** Whether this tab starts on screen. `setVisibility` owns it from then on. */
  visible?: boolean;
}

interface Peer {
  seenAt: number;
  visible: boolean;
}

/**
 * Keeps two tabs off the same file.
 *
 * `file://` puts every local page on one origin, so IndexedDB and
 * BroadcastChannel are shared — but two tabs editing the same `.fish.html`
 * would still be last-writer-wins on the file itself, silently discarding
 * whichever one flushed first. This is not a lock and not consensus: every tab
 * computes the same winner from the same set of (id, visible) pairs, so they
 * agree without a round trip, and a tab that dies stops sending heartbeats and
 * is dropped from the set.
 *
 * **Visibility outranks arrival order, and it has to.** A tab the browser has
 * put in the background gets its `setInterval` throttled to a minute or more,
 * so it stops answering heartbeats — and a peer that treated that silence as
 * "it is gone" would re-arm write-back while the throttled tab still believed
 * it was the writer, and the two would overwrite each other's flushes. So the
 * tab that hands over is the hidden one, and it hands over the instant it goes
 * hidden (`setVisibility`), long before any timeout could fire. The timeout is
 * left with the one job it can still do honestly: forgetting a tab that closed.
 */
export class TabCoordinator {
  private readonly aliveMs: number;
  private readonly timeoutMs: number;
  private peers = new Map<string, Peer>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private superseded = false;
  private visible: boolean;

  constructor(
    private channel: TabChannel,
    private opts: TabCoordinatorOptions,
    private now: () => number = () => Date.now()
  ) {
    this.aliveMs = opts.aliveMs ?? 4000;
    this.timeoutMs = opts.timeoutMs ?? this.aliveMs * 3;
    this.visible = opts.visible ?? true;
  }

  isSuperseded(): boolean {
    return this.superseded;
  }

  /**
   * Follow the page's own visibility.
   *
   * Standing down before announcing is deliberate: this tab must have stopped
   * writing before the tab it is handing over to starts, and by the time the
   * message lands, `onSuperseded` has already run.
   */
  setVisibility(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.reevaluate();
    this.announce("alive");
  }

  /** A save-as adopted a new file: coordinate on that identity from now on. */
  setFileId(fileId: string): void {
    if (this.opts.fileId === fileId) return;
    const wasSuperseded = this.superseded;
    this.opts.fileId = fileId;
    this.peers.clear();
    // The old file's winner has no claim on the new one. Waiting for the next
    // heartbeat would leave write-back paused for up to one `aliveMs` after a
    // save-as moved this tab to a file nobody else has open.
    this.superseded = false;
    this.announce("hello");
    if (wasSuperseded) this.opts.onRegained();
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.channel.subscribe((msg) => this.receive(msg));
    this.announce("hello");
    this.timer = setInterval(() => this.tick(), this.aliveMs);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.channel.close();
  }

  private announce(kind: TabMessage["kind"]): void {
    this.channel.post({
      kind,
      fileId: this.opts.fileId,
      tabId: this.opts.tabId,
      visible: this.visible
    });
  }

  /**
   * The tab that should be writing: the lowest id among the tabs on screen, or
   * among all of them when none is (two hidden tabs still need one writer).
   */
  private leaderId(): string {
    const cutoff = this.now() - this.timeoutMs;
    const candidates: { id: string; visible: boolean }[] = [
      { id: this.opts.tabId, visible: this.visible }
    ];
    for (const [id, peer] of this.peers) {
      if (peer.seenAt >= cutoff) candidates.push({ id, visible: peer.visible });
    }
    const onScreen = candidates.filter((c) => c.visible);
    const pool = onScreen.length > 0 ? onScreen : candidates;
    let leader = pool[0];
    for (const c of pool) if (c.id < leader.id) leader = c;
    return leader.id;
  }

  /** Move this tab to the role the current peer set implies, and say so once. */
  private reevaluate(): void {
    const leader = this.leaderId();
    if (leader === this.opts.tabId) {
      if (!this.superseded) return;
      this.superseded = false;
      this.opts.onRegained();
      return;
    }
    if (this.superseded) return;
    this.superseded = true;
    this.opts.onSuperseded(leader);
  }

  private receive(msg: TabMessage): void {
    // Every `file://` page shares one channel, so messages for other files are
    // routine, not exceptional.
    if (msg.fileId !== this.opts.fileId) return;
    if (msg.tabId === this.opts.tabId) return;
    this.peers.set(msg.tabId, { seenAt: this.now(), visible: msg.visible !== false });
    // Answer a greeting: whoever started first broadcast its `hello` before this
    // tab was listening, so without a reply the two would never see each other.
    if (msg.kind === "hello") this.announce("alive");
    this.reevaluate();
  }

  private tick(): void {
    const cutoff = this.now() - this.timeoutMs;
    for (const [id, peer] of this.peers) {
      if (peer.seenAt < cutoff) this.peers.delete(id);
    }
    this.reevaluate();
    this.announce("alive");
  }
}

export function createBroadcastTabChannel(name = "fish-tabs"): TabChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(name);
  return {
    post: (msg) => channel.postMessage(msg),
    subscribe: (cb) => {
      const handler = (e: MessageEvent) => cb(e.data as TabMessage);
      channel.addEventListener("message", handler);
      return () => channel.removeEventListener("message", handler);
    },
    close: () => channel.close()
  };
}
