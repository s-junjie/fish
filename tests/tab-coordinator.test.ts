import { describe, it, expect, vi } from "vitest";
import {
  TabCoordinator,
  type TabChannel,
  type TabMessage
} from "../src/core/persistence/tab-coordinator";

/** Two channels wired to each other, like two tabs on the same origin. */
function pair(): [TabChannel, TabChannel] {
  const subs: ((m: TabMessage) => void)[][] = [[], []];
  const make = (self: number, other: number): TabChannel => ({
    post: (m) => subs[other].forEach((cb) => cb(m)),
    subscribe: (cb) => {
      subs[self].push(cb);
      return () => {
        subs[self] = subs[self].filter((c) => c !== cb);
      };
    },
    close: () => {
      subs[self] = [];
    }
  });
  return [make(0, 1), make(1, 0)];
}

describe("TabCoordinator", () => {
  it("lets the lower tab id keep writing and stands the other one down", () => {
    const [a, b] = pair();
    const standDown = vi.fn();
    const lower = new TabCoordinator(a, {
      fileId: "file_1",
      tabId: "tab_a",
      onSuperseded: standDown,
      onRegained: vi.fn()
    });
    const higher = new TabCoordinator(b, {
      fileId: "file_1",
      tabId: "tab_b",
      onSuperseded: standDown,
      onRegained: vi.fn()
    });
    lower.start();
    higher.start();

    // Deterministic and symmetric: both compute the same winner from the same
    // pair of ids, so neither has to ask the other.
    expect(standDown).toHaveBeenCalledTimes(1);
    expect(lower.isSuperseded()).toBe(false);
    expect(higher.isSuperseded()).toBe(true);
    lower.stop();
    higher.stop();
  });

  it("ignores tabs showing a different file", () => {
    // Every `file://` page shares one origin and one channel, so traffic for
    // other files is the common case, not an edge case.
    const [a, b] = pair();
    const standDown = vi.fn();
    const one = new TabCoordinator(a, {
      fileId: "file_1",
      tabId: "tab_b",
      onSuperseded: standDown,
      onRegained: vi.fn()
    });
    const two = new TabCoordinator(b, {
      fileId: "file_2",
      tabId: "tab_a",
      onSuperseded: standDown,
      onRegained: vi.fn()
    });
    one.start();
    two.start();
    expect(standDown).not.toHaveBeenCalled();
    one.stop();
    two.stop();
  });

  it("regains immediately when a save-as moves this tab to another file", () => {
    // The old file's winner has no claim on the new one. Waiting for the next
    // heartbeat left write-back paused for up to `aliveMs` after Save As.
    const [a, b] = pair();
    const regained = vi.fn();
    const lower = new TabCoordinator(a, {
      fileId: "file_1",
      tabId: "tab_a",
      onSuperseded: vi.fn(),
      onRegained: vi.fn()
    });
    const higher = new TabCoordinator(b, {
      fileId: "file_1",
      tabId: "tab_b",
      onSuperseded: vi.fn(),
      onRegained: regained
    });
    lower.start();
    higher.start();
    expect(higher.isSuperseded()).toBe(true);

    higher.setFileId("file_2");

    expect(higher.isSuperseded()).toBe(false);
    expect(regained).toHaveBeenCalledTimes(1);
    lower.stop();
    higher.stop();
  });

  it("takes over again once the other tab stops responding", () => {
    const [a, b] = pair();
    let clock = 0;
    const regained = vi.fn();
    const higher = new TabCoordinator(
      b,
      {
        fileId: "file_1",
        tabId: "tab_b",
        onSuperseded: vi.fn(),
        onRegained: regained,
        aliveMs: 1000,
        timeoutMs: 3000
      },
      () => clock
    );
    const lower = new TabCoordinator(a, {
      fileId: "file_1",
      tabId: "tab_a",
      onSuperseded: vi.fn(),
      onRegained: vi.fn(),
      aliveMs: 1000,
      timeoutMs: 3000
    });
    lower.start();
    higher.start();
    expect(higher.isSuperseded()).toBe(true);

    // The other tab goes away without saying goodbye; only silence tells us.
    lower.stop();
    clock += 10000;
    (higher as unknown as { tick: () => void }).tick();

    expect(higher.isSuperseded()).toBe(false);
    expect(regained).toHaveBeenCalled();
    higher.stop();
  });

  /**
   * The browser throttles a background tab's `setInterval` to a minute or more.
   * Judging that tab by its silence is how two tabs ended up writing the same
   * file at once, so the hidden tab has to give the file up on its own — the
   * `visibilitychange` handler is not throttled, and that is the whole point.
   */
  it("hands the file over the moment it goes off screen", () => {
    const [a, b] = pair();
    let clock = 0;
    const lowerDown = vi.fn();
    const higherUp = vi.fn();
    const hidden = new TabCoordinator(
      a,
      { fileId: "file_1", tabId: "tab_a", onSuperseded: lowerDown, onRegained: vi.fn() },
      () => clock
    );
    const front = new TabCoordinator(
      b,
      { fileId: "file_1", tabId: "tab_b", onSuperseded: vi.fn(), onRegained: higherUp },
      () => clock
    );
    hidden.start();
    front.start();
    expect(front.isSuperseded()).toBe(true);

    hidden.setVisibility(false);

    // The visible tab owns the file now, and the hidden one says so itself.
    expect(hidden.isSuperseded()).toBe(true);
    expect(lowerDown).toHaveBeenCalledWith("tab_b");
    expect(front.isSuperseded()).toBe(false);
    expect(higherUp).toHaveBeenCalledTimes(1);

    // A minute on: the visible tab has kept its own clock, the throttled one
    // finally wakes. Neither may change hands.
    clock += 60_000;
    (front as unknown as { tick: () => void }).tick();
    (hidden as unknown as { tick: () => void }).tick();
    expect(front.isSuperseded()).toBe(false);
    expect(hidden.isSuperseded()).toBe(true);
    hidden.stop();
    front.stop();
  });

  it("keeps writing while hidden when no tab is on screen", () => {
    // Switching to another app must not stop auto-save: with no peer, or with
    // peers that are hidden too, the page nobody is looking at is still the one
    // that has to keep the file up to date.
    const [a, b] = pair();
    let clock = 0;
    const lowerDown = vi.fn();
    const higherDown = vi.fn();
    const lower = new TabCoordinator(
      a,
      { fileId: "file_1", tabId: "tab_a", visible: false, onSuperseded: lowerDown, onRegained: vi.fn() },
      () => clock
    );
    lower.start();
    expect(lower.isSuperseded()).toBe(false);

    const higher = new TabCoordinator(
      b,
      { fileId: "file_1", tabId: "tab_b", visible: false, onSuperseded: higherDown, onRegained: vi.fn() },
      () => clock
    );
    higher.start();
    // Both hidden, so visibility ranks nobody: the lower id still writes, and
    // there is exactly one writer.
    expect(lower.isSuperseded()).toBe(false);
    expect(higher.isSuperseded()).toBe(true);
    expect(higherDown).toHaveBeenCalledWith("tab_a");
    expect(lowerDown).not.toHaveBeenCalled();

    // Back on screen: still the writer, and still no handover.
    lower.setVisibility(true);
    clock += 4_000;
    (lower as unknown as { tick: () => void }).tick();
    (higher as unknown as { tick: () => void }).tick();
    expect(lower.isSuperseded()).toBe(false);
    expect(higher.isSuperseded()).toBe(true);
    lower.stop();
    higher.stop();
  });
});
