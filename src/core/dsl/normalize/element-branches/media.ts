import { asBoolean } from "../shared";
import { cornerRadiusInput, normalizeCornerRadius } from "../stroke";
import { isFrameableUrl } from "../../html-source";
import type { ElementBranch } from "./shared";

export const normalizeVideo: ElementBranch = ({ el, base, path, repairs, box }) => {
  const assetId = el.assetId ?? el.asset;
  if (typeof assetId === "string" && assetId.trim()) {
    base.assetId = assetId.trim();
  } else {
    base.assetId = "";
    repairs.push({
      kind: "element",
      path: `${path}/assetId`,
      severity: "info",
      message: 'video element had no "assetId"'
    });
  }

  if (el.autoplay !== undefined) base.autoplay = asBoolean(el.autoplay) ?? false;
  if (el.loop !== undefined) base.loop = asBoolean(el.loop) ?? true;
  if (el.muted !== undefined) base.muted = asBoolean(el.muted) ?? true;
  if (el.controls !== undefined) base.controls = asBoolean(el.controls) ?? true;

  const poster = el.posterAssetId;
  if (typeof poster === "string" && poster.trim()) {
    base.posterAssetId = poster.trim();
  }

  const radius = normalizeCornerRadius(cornerRadiusInput(el), path, repairs, box);
  if (radius !== undefined) base.borderRadius = radius;
};

export const normalizeHtml: ElementBranch = ({ el, base, path, repairs, box }) => {
  // The two sources stay two fields rather than one, because the renderer
  // needs a different iframe attribute for each and guessing from the string
  // ("does it look like a URL?") would send a document whose first line
  // happens to be a link to the wrong one.
  //
  // The scheme is checked HERE, at the point the document is read, rather
  // than only where the picker offers a URL: this element renders straight
  // into an iframe `src`, and a document reaches this code from outside the
  // app as well as from inside it. A dropped `src` falls back to `srcdoc`,
  // and to the empty frame below if there is no `srcdoc` either.
  const rawSrc = typeof el.src === "string" ? el.src.trim() : "";
  const src = isFrameableUrl(rawSrc) ? rawSrc : "";
  const srcdoc = typeof el.srcdoc === "string" ? el.srcdoc : "";
  if (src) base.src = src;
  if (srcdoc) base.srcdoc = srcdoc;
  if (rawSrc && !src) {
    repairs.push({
      kind: "element",
      path: `${path}/src`,
      message: `html element src ${JSON.stringify(rawSrc.slice(0, 80))} is not an http(s) URL and was dropped; only a page the browser can fetch may be framed`
    });
  }
  // Reported rather than dropped: an embed with neither source is an empty
  // frame that looks like a rendering failure, and this is the only place
  // that knows the document asked for one.
  if (!src && !srcdoc) {
    repairs.push({
      kind: "element",
      path: `${path}/src`,
      severity: "info",
      message: 'html element had neither "src" nor "srcdoc"; it renders an empty frame'
    });
  }

  const radius = normalizeCornerRadius(cornerRadiusInput(el), path, repairs, box);
  if (radius !== undefined) base.borderRadius = radius;

  const poster = el.posterAssetId;
  if (typeof poster === "string" && poster.trim()) {
    base.posterAssetId = poster.trim();
  }

  const cachedTitle = el.cachedTitle;
  if (typeof cachedTitle === "string" && cachedTitle.trim()) {
    base.cachedTitle = cachedTitle.trim();
  }

  const cachedFavicon = el.cachedFavicon;
  if (typeof cachedFavicon === "string" && cachedFavicon.trim()) {
    base.cachedFavicon = cachedFavicon.trim();
  }

  // Read only when present, so the field is absent rather than `false` on an
  // embed that never asked: the whole point of the flag is that off is the
  // default, and a written `false` on every layer is noise on the wire.
  if (el.alwaysLive !== undefined) base.alwaysLive = asBoolean(el.alwaysLive) ?? false;
};
