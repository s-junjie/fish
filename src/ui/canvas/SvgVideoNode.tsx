import { VideoElement } from "../../core/dsl/types";
import { cornerRadiiOf } from "../../core/geometry/shape-path";
import { isIframeVideoUrl } from "../../core/interactions/video-loader";
import { CANVAS_BADGE_SURFACE, CANVAS_BADGE_RIDGE } from "./canvas-colors";
import { NodeRenderContext } from "./NodeRenderContext";

export interface SvgVideoNodeProps {
  el: VideoElement;
  shapeLocalD: string;
  resolveAssetUri: (assetId: string) => string | undefined;
  ctx: NodeRenderContext;
  onDoubleClick: (e: MouseEvent) => void;
}

export function SvgVideoNode({
  el,
  shapeLocalD,
  resolveAssetUri,
  ctx,
  onDoubleClick
}: SvgVideoNodeProps) {
  const uri = resolveAssetUri(el.assetId);
  const [tl, tr, br, bl] = cornerRadiiOf(el.borderRadius, el.width, el.height);
  const radiusStyle = `${tl}px ${tr}px ${br}px ${bl}px`;
  const isIframe = uri ? isIframeVideoUrl(uri) : false;
  const isPresent = ctx.frameTitles === false;
  const pe = isPresent ? "auto" : "none";
  const commonStyle = { overflow: "hidden", borderRadius: radiusStyle, pointerEvents: pe } as const;

  return (
    <g
      transform={`translate(${el.x}, ${el.y})`}
      onMouseDown={(e) => ctx.onElementMouseDown(e, el)}
      onDblClick={onDoubleClick}
    >
      {uri ? (
        <foreignObject
          x={0}
          y={0}
          width={el.width}
          height={el.height}
          style={commonStyle}
        >
          {/* No `position: relative` here: WebKit drops the wrapping `<g>`'s
              transform for a foreignObject whose HTML content establishes a
              containing block, and paints the video at the page origin. */}
          <div
            style={{
              width: "100%",
              height: "100%",
              backgroundColor: "black",
              ...commonStyle
            }}
          >
            {isIframe ? (
              <iframe
                src={uri}
                title={el.name || "Video"}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  display: "block",
                  ...commonStyle
                }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            ) : (
              <video
                data-video-id={el.id}
                src={uri}
                autoPlay={el.autoplay}
                loop={el.loop !== false}
                muted={el.muted !== false}
                controls={el.controls !== false}
                playsInline
                preload="auto"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                  ...commonStyle
                }}
              />
            )}
          </div>
        </foreignObject>
      ) : (
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
