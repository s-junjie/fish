import { normalizeLink } from "../core/dsl/link";

export const LINK_ATTRIBUTE = "data-link";

/** The URL of the nearest linked ancestor of an event target, or null. */
export function linkAtTarget(target: EventTarget | null): string | null {
  const node = target as Element | null;
  if (!node || typeof (node as Element).closest !== "function") return null;
  const raw = node.closest(`[${LINK_ATTRIBUTE}]`)?.getAttribute(LINK_ATTRIBUTE);
  // Re-normalized at the point of use rather than trusted: the attribute round
  // trips through the DOM, and the one path that must never carry a `javascript:`
  // URL is the one that hands it to the browser.
  return raw ? (normalizeLink(raw) ?? null) : null;
}

/** Opens a URL in a new tab and severs `opener`. False when it is not a link. */
export function openLinkInNewTab(url: string): boolean {
  const href = normalizeLink(url);
  if (!href || typeof window === "undefined") return false;
  // The features string is left out on purpose: passing one makes browsers treat
  // the request as a popup, which gives a small window instead of a tab.
  const opened = window.open(href, "_blank");
  if (opened) opened.opener = null;
  return true;
}

/**
 * Opens the nearest linked ancestor of the event target. `false` means the click
 * landed on something with no link, which is a caller's cue to do its own thing
 * with the event — advance a slide, leave a selection alone.
 */
export function openLinkFromEvent(event: { target: EventTarget | null }): boolean {
  const href = linkAtTarget(event.target);
  return href ? openLinkInNewTab(href) : false;
}
