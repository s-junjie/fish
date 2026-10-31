import { HtmlEmbedElement } from "../../core/dsl/types";
import { cornerRadiiOf } from "../../core/geometry/shape-path";
import { htmlNameFromUrl } from "../../core/interactions/html-embed-loader";
import { injectSnapshotHelper } from "../../core/interactions/html-embed-snapshot";
import { t } from "../../i18n";
import {
  CANVAS_BADGE_SURFACE,
  CANVAS_BADGE_RIDGE,
  CANVAS_BADGE_INK,
  CANVAS_GUIDE
} from "./canvas-colors";
import { NodeRenderContext } from "./NodeRenderContext";

/**
 * What the framed document is allowed to do.
 *
 * `allow-same-origin` is deliberately absent from BOTH branches, and it is the
 * load-bearing omission. An `srcdoc` document inherits the embedding page's
 * origin, so granting it same-origin access would let a picked `.html` reach
 * straight into the app — its DOM, its `localStorage`, and the IndexedDB that
 * holds every autosave backup and file handle. Without the token the frame is
 * forced into an opaque origin and can do none of that.
 */
export const HTML_EMBED_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";

export interface SvgHtmlEmbedNodeProps {
  el: HtmlEmbedElement;
  shapeLocalD: string;
  resolveAssetUri?: (assetId: string) => string | undefined;
  /**
   * The node's own selected state, already resolved by `renderNodeList`.
   *
   * It used to be read off `ctx.selectedIds`, which made every node's memo
   * compare the whole set — the expensive half of a selection change. A leaf
   * has no descendants to pass it to, so the prop is its only source.
   */
  isSelected?: boolean;
  ctx: NodeRenderContext;
  onDoubleClick: (e: MouseEvent) => void;
}

export function SvgHtmlEmbedNode({
  el,
  shapeLocalD,
  resolveAssetUri,
  isSelected,
  ctx,
  onDoubleClick
}: SvgHtmlEmbedNodeProps) {
  const [tl, tr, br, bl] = cornerRadiiOf(el.borderRadius, el.width, el.height);
  const radiusStyle = `${tl}px ${tr}px ${br}px ${bl}px`;

  /**
   * Two states, and selecting is the trigger.
   *
   * Present mode IS the page: the frame takes the pointer and the viewer
   * scrolls and clicks inside it. On the canvas an embed is only ever a
   * PREVIEW — mounted the moment its layer is selected, so the author looks at
   * the real thing rather than a poster that may be a version behind.
   *
   * The pointer is NOT handed over with it. A frame that hit-tests swallows
   * the press that starts a drag, so a selected preview would be a layer that
   * cannot be moved; keeping `pointerEvents: none` leaves the hit path below
   * owning the press, and only present mode ever gives the page the mouse.
   *
   * `alwaysLive` is the opt-out from "selected is the trigger": the layer asks
   * to stay mounted at rest, which costs a running document but is the only
   * way a page that animates on its own is ever seen moving. It changes
   * nothing else — the pointer still belongs to the canvas, so the layer is
   * still draggable in front of its own content.
   */
  const isPresent = ctx.frameTitles === false;
  const isSelectedHere = !isPresent && (isSelected ?? ctx.selectedIds.has(el.id));
  const isMountLive = isPresent || isSelectedHere || el.alwaysLive === true;

  const pe = isPresent ? "auto" : "none";
  const commonStyle = { overflow: "hidden", borderRadius: radiusStyle, pointerEvents: pe } as const;
  const hasSource = Boolean(el.src || el.srcdoc);

  const posterUri = el.posterAssetId
    ? (resolveAssetUri
        ? resolveAssetUri(el.posterAssetId)
        : (ctx.registry?.getAsset(el.posterAssetId) ??
           ctx.docRef?.current?.assets?.find((a) => a.id === el.posterAssetId))?.uri)
    : undefined;

  const source: Record<string, string> = el.src
    ? { src: el.src }
    : { srcdoc: injectSnapshotHelper(el.srcdoc ?? "", el.id) };

  const cx = Math.round(el.width / 2);
  const cy = Math.round(el.height / 2);
  const canFitCard = el.width >= 120 && el.height >= 80;
  const canFitBadge = el.width >= 200 && el.height >= 140;

  const titleText = el.cachedTitle || el.name || t("htmlEmbed.title");
  const subText = el.src ? htmlNameFromUrl(el.src) : t("htmlEmbed.kindInline");

  return (
    <g
      transform={`translate(${el.x}, ${el.y})`}
      onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
      onDblClick={onDoubleClick}
    >
      {isMountLive && hasSource ? (
        <foreignObject x={0} y={0} width={el.width} height={el.height} style={commonStyle}>
          {/* No `position: relative` here: WebKit drops the wrapping `<g>`'s
              transform for a foreignObject whose HTML content establishes a
              containing block, and paints the embed at the page origin. */}
          <div
            style={{
              width: "100%",
              height: "100%",
              backgroundColor: "white",
              ...commonStyle
            }}
          >
            <iframe
              data-html-embed-id={el.id}
              {...source}
              title={titleText}
              sandbox={HTML_EMBED_SANDBOX}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                display: "block",
                ...commonStyle
              }}
            />
          </div>
        </foreignObject>
      ) : posterUri ? (
        <g>
          <clipPath id={`clip-html-${el.id}`}>
            <path d={shapeLocalD} />
          </clipPath>
          <image
            href={posterUri}
            x={0}
            y={0}
            width={el.width}
            height={el.height}
            preserveAspectRatio="none"
            clipPath={`url(#clip-html-${el.id})`}
          />
        </g>
      ) : (
        <g>
          <rect
            x={0}
            y={0}
            width={el.width}
            height={el.height}
            rx={tl}
            fill={CANVAS_BADGE_SURFACE}
            stroke={CANVAS_BADGE_RIDGE}
            strokeWidth={1}
          />
          {canFitCard && (
            <g pointerEvents="none">
              {el.cachedFavicon ? (
                <image
                  href={el.cachedFavicon}
                  x={cx - 10}
                  y={cy - 36}
                  width={20}
                  height={20}
                  preserveAspectRatio="contain"
                />
              ) : (
                <circle cx={cx} cy={cy - 26} r={10} fill="none" stroke={CANVAS_GUIDE} strokeWidth={1} />
              )}
              <text
                x={cx}
                y={cy - 4}
                textAnchor="middle"
                fill={CANVAS_BADGE_INK}
                fontSize={12}
                fontFamily="ui-monospace, monospace"
                fontWeight="600"
              >
                {titleText}
              </text>
              <text
                x={cx}
                y={cy + 12}
                textAnchor="middle"
                fill={CANVAS_GUIDE}
                fontSize={9.5}
                fontFamily="ui-monospace, monospace"
              >
                {subText}
              </text>
              {canFitBadge && (
                <g>
                  <rect
                    x={cx - 72}
                    y={cy + 24}
                    width={144}
                    height={18}
                    rx={4}
                    fill={CANVAS_BADGE_RIDGE}
                  />
                  <text
                    x={cx}
                    y={cy + 36}
                    textAnchor="middle"
                    fill={CANVAS_BADGE_INK}
                    fontSize={8.5}
                    fontFamily="ui-monospace, monospace"
                  >
                    {t("htmlEmbed.badgeResting")}
                  </text>
                </g>
              )}
            </g>
          )}
        </g>
      )}

      {!isPresent && (
        <path
          d={shapeLocalD}
          fill="transparent"
          data-hit="true"
          stroke="transparent"
          pointerEvents="all"
        />
      )}
    </g>
  );
}
