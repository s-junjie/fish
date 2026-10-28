export interface TabMessage {
  kind: "hello" | "alive";
  fileId: string;
  tabId: string;
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
  /** That tab is gone; this one may write back again. */
  onRegained: () => void;
  aliveMs?: number;
  timeoutMs?: number;
}

/**
 * Keeps two tabs off the same file.
 *
 * `file://` puts every local page on one origin, so IndexedDB and
 * BroadcastChannel are shared — but two tabs editing the same `.fish.html`
 * would still be last-writer-wins on the file itself, silently discarding
 * whichever one flushed first. This is not a lock and not consensus: the tab
 * with the lower id simply defers, so both tabs agree on the winner without a
 * round trip, and a tab that dies stops sending heartbeats and is forgotten.
 */
export class TabCoordinator {
  private readonly aliveMs: number;
  private readonly timeoutMs: number;
  private peers = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private superseded = false;

  constructor(
    private channel: TabChannel,
    private opts: TabCoordinatorOptions,
    private now: () => number = () => Date.now()
  ) {
    this.aliveMs = opts.aliveMs ?? 4000;
    this.timeoutMs = opts.timeoutMs ?? this.aliveMs * 3;
  }

  isSuperseded(): boolean {
    return this.superseded;
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
    this.channel.post({ kind, fileId: this.opts.fileId, tabId: this.opts.tabId });
  }

  private receive(msg: TabMessage): void {
    // Every `file://` page shares one channel, so messages for other files are
    // routine, not exceptional.
    if (msg.fileId !== this.opts.fileId) return;
    if (msg.tabId === this.opts.tabId) return;
    this.peers.set(msg.tabId, this.now());
    // Answer a greeting: whoever started first broadcast its `hello` before this
    // tab was listening, so without a reply the two would never see each other.
    if (msg.kind === "hello") this.announce("alive");
    // Deterministic winner: the lower tab id keeps writing. Both tabs compute
    // the same answer from the same pair, so neither has to ask.
    if (msg.tabId < this.opts.tabId && !this.superseded) {
      this.superseded = true;
      this.opts.onSuperseded(msg.tabId);
    }
  }

  private tick(): void {
    const cutoff = this.now() - this.timeoutMs;
    for (const [id, seen] of this.peers) {
      if (seen < cutoff) this.peers.delete(id);
    }
    if (this.superseded && this.peers.size === 0) {
      this.superseded = false;
      this.opts.onRegained();
    }
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
