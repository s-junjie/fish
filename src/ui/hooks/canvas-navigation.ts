/**
 * Whether a canvas press is NAVIGATION rather than a click.
 *
 * Space (a temporary pan) and the hand tool both turn the pointer into a camera
 * control: the press moves the page under the window, touches nothing in the
 * document, and leaves every floating panel where it is — a panel is anchored to
 * the inspector, not to the page beneath it. Without this, panning with a
 * gradient's fill panel open closed the panel, and the grip the user was about to
 * aim with went with it.
 *
 * A module store for the reason the others here are (`picker-focus`,
 * `inspector-activity`): the flag is written where the tool and the key live and
 * read from a popover portal, and the two share no re-rendering parent. It is
 * read synchronously inside the press handler, so it needs no listeners.
 */
let navigating = false;

export function setCanvasNavigation(active: boolean): void {
  navigating = active;
}

export function isCanvasNavigation(): boolean {
  return navigating;
}
