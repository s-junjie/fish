import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import {
  computeVideoTargetSize,
  isVideoUrl,
  isVideoFile,
  createVideoElement,
  parseVideoUrl,
  isIframeVideoUrl,
  isVideoAsset,
  isVideoAssetUri,
  MAX_VIDEO_EDGE
} from "../src/core/interactions/video-loader";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { VideoElement } from "../src/core/dsl/types";

describe("video loader & element support", () => {
  it("detects video URLs and files correctly", () => {
    expect(isVideoUrl("https://example.com/video.mp4")).toBe(true);
    expect(isVideoUrl("https://example.com/movie.webm?query=1")).toBe(true);
    expect(isVideoUrl("https://example.com/image.png")).toBe(false);
    expect(isVideoUrl("data:video/mp4;base64,AAAA")).toBe(true);
    expect(isVideoUrl("data:image/png;base64,AAAA")).toBe(false);

    expect(isVideoFile({ type: "video/mp4", name: "test.mp4" } as File)).toBe(true);
    expect(isVideoFile({ type: "", name: "clip.mov" } as File)).toBe(true);
    expect(isVideoFile({ type: "image/png", name: "test.png" } as File)).toBe(false);
  });

  it("parses mainstream video platforms into embed URLs", () => {
    // YouTube
    const ytWatch = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(ytWatch.isEmbed).toBe(true);
    expect(ytWatch.platform).toBe("youtube");
    expect(ytWatch.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");

    const ytShort = parseVideoUrl("https://youtu.be/dQw4w9WgXcQ?si=abc");
    expect(ytShort.isEmbed).toBe(true);
    expect(ytShort.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");

    const ytShorts = parseVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
    expect(ytShorts.isEmbed).toBe(true);
    expect(ytShorts.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");

    // Vimeo
    const vimeo = parseVideoUrl("https://vimeo.com/76979871");
    expect(vimeo.isEmbed).toBe(true);
    expect(vimeo.platform).toBe("vimeo");
    expect(vimeo.embedUrl).toBe("https://player.vimeo.com/video/76979871");

    // Bilibili
    const bili = parseVideoUrl("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(bili.isEmbed).toBe(true);
    expect(bili.platform).toBe("bilibili");
    expect(bili.embedUrl).toContain("player.bilibili.com/player.html?bvid=BV1xx411c7mD");

    // Dailymotion
    const dm = parseVideoUrl("https://www.dailymotion.com/video/x7tgad0");
    expect(dm.isEmbed).toBe(true);
    expect(dm.platform).toBe("dailymotion");
    expect(dm.embedUrl).toBe("https://www.dailymotion.com/embed/video/x7tgad0");

    // Direct video
    const direct = parseVideoUrl("https://example.com/stream.mp4");
    expect(direct.isEmbed).toBe(false);
    expect(direct.platform).toBe("direct");
    expect(direct.embedUrl).toBe("https://example.com/stream.mp4");

    expect(isIframeVideoUrl("https://www.youtube-nocookie.com/embed/123")).toBe(true);
    expect(isIframeVideoUrl("https://player.vimeo.com/video/123")).toBe(true);
    expect(isIframeVideoUrl("https://example.com/video.mp4")).toBe(false);
  });

  it("matches the player host and path, not a substring of the whole URL", () => {
    // Every host `parseVideoUrl` can produce, plus the subdomain spellings a
    // pasted embed snippet arrives in.
    for (const url of [
      "https://www.youtube.com/embed/abc",
      "https://youtube.com/embed/abc",
      "https://m.youtube.com/embed/abc",
      "https://www.youtube-nocookie.com/embed/abc",
      "https://player.vimeo.com/video/123",
      "https://player.bilibili.com/player.html?bvid=BV1",
      "https://www.dailymotion.com/embed/video/x7tgad0",
      "http://www.youtube.com/embed/abc",
      "https://www.youtube.com/embed/abc?autoplay=1"
    ]) {
      expect(isIframeVideoUrl(url), url).toBe(true);
    }

    // The substring match these replaced answered true for all of these, and
    // every one of them renders as a live unsandboxed frame that can script.
    for (const url of [
      "https://example.com/?r=youtube.com/embed/",
      "https://notyoutube.com/embed/abc",
      "https://youtube.com.evil.example/embed/abc",
      "https://www.youtube.com/watch?v=abc",
      "https://youtube.com/redirect?u=youtube.com/embed/abc",
      "data:text/html,<iframe src=youtube.com/embed/>",
      "youtube.com/embed/abc",
      ""
    ]) {
      expect(isIframeVideoUrl(url), url).toBe(false);
    }
  });

  it("computes video target size bounded by MAX_VIDEO_EDGE (640)", () => {
    expect(MAX_VIDEO_EDGE).toBe(640);

    // Landscape 1920x1080 -> width=640, height=360
    const landscape = computeVideoTargetSize(1920, 1080);
    expect(landscape.width).toBe(640);
    expect(landscape.height).toBe(360);

    // Portrait 1080x1920 -> width=360, height=640
    const portrait = computeVideoTargetSize(1080, 1920);
    expect(portrait.width).toBe(360);
    expect(portrait.height).toBe(640);

    // Square 1000x1000 -> 640x640
    const square = computeVideoTargetSize(1000, 1000);
    expect(square.width).toBe(640);
    expect(square.height).toBe(640);

    // Smaller than MAX_VIDEO_EDGE -> keep original size
    const small = computeVideoTargetSize(320, 240);
    expect(small.width).toBe(320);
    expect(small.height).toBe(240);
  });

  it("creates a properly configured VideoElement", () => {
    const videoEl = createVideoElement({
      assetId: "v-asset-1",
      width: 640,
      height: 360,
      x: 100,
      y: 150,
      name: "Demo Video"
    });
    expect(videoEl.type).toBe("video");
    expect(videoEl.assetId).toBe("v-asset-1");
    expect(videoEl.x).toBe(100);
    expect(videoEl.y).toBe(150);
    expect(videoEl.width).toBe(640);
    expect(videoEl.height).toBe(360);
    expect(videoEl.name).toBe("Demo Video");
    expect(videoEl.constraints?.preserveAspectRatio).toBe(true);
    expect(videoEl.loop).toBe(true);
    expect(videoEl.muted).toBe(true);
    expect(videoEl.controls).toBe(true);
  });

  it("normalizes video element preserving video properties", () => {
    const rawDoc = {
      version: "0.1",
      canvas: { width: 1920, height: 1080, unit: "px" },
      assets: [
        {
          id: "vid_1",
          name: "clip.mp4",
          uri: "https://example.com/clip.mp4",
          width: 1280,
          height: 720,
          duration: 15.5
        }
      ],
      elements: [
        {
          id: "el_vid",
          type: "video",
          name: "Hero Video",
          assetId: "vid_1",
          x: 50,
          y: 50,
          width: 640,
          height: 360,
          autoplay: true,
          loop: false,
          muted: false,
          controls: true,
          borderRadius: 8
        }
      ]
    };

    const { document, repairs } = normalizeDesignDocument(rawDoc as any);
    expect(repairs).toEqual([]);
    const el = getActivePage(document).children[0] as VideoElement;
    expect(el.type).toBe("video");
    expect(el.assetId).toBe("vid_1");
    expect(el.autoplay).toBe(true);
    expect(el.loop).toBe(false);
    expect(el.muted).toBe(false);
    expect(el.controls).toBe(true);
    expect(el.borderRadius).toBe(8);
    expect(document.assets?.[0].duration).toBe(15.5);
  });
  it("tells a video asset from an image asset by what points at it, not by the uri alone", () => {
    // The `data:` case is the trap: a base64 PNG carries no `.png` filename, so a
    // plain extension regex reads the whole URI and a data video reads as an image.
    expect(isVideoAssetUri("data:image/png;base64,AAAA")).toBe(false);
    expect(isVideoAssetUri("data:video/mp4;base64,AAAA")).toBe(true);
    expect(isVideoAssetUri("https://cdn.test/clip.mp4")).toBe(true);
    expect(isVideoAssetUri("https://cdn.test/clip.mp4?token=1")).toBe(true);
    expect(isVideoAssetUri("https://cdn.test/photo.png")).toBe(false);

    // An extensionless source URL is only knowable from the element that uses it.
    expect(isVideoAssetUri("https://cdn.test/stream/1234")).toBe(false);

    const doc = {
      version: "0.1",
      id: "doc_1",
      name: "d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas: { unit: "px", background: { type: "solid", color: "#FFFFFF" } },
      pages: [
        {
          id: "p1",
          name: "Page 1",
          canvas: { unit: "px", background: { type: "solid", color: "#FFFFFF" } },
          children: [
            {
              id: "v1",
              type: "video",
              x: 0,
              y: 0,
              width: 640,
              height: 360,
              assetId: "a_stream"
            }
          ]
        }
      ],
      activePageId: "p1",
      elements: []
    } as any;

    expect(isVideoAsset(doc, { id: "a_stream", name: "stream", uri: "https://cdn.test/stream/1234" })).toBe(true);
    expect(isVideoAsset(doc, { id: "a_photo", name: "p", uri: "https://cdn.test/p.png" })).toBe(false);
    expect(isVideoAsset(doc, { id: "a_mov", name: "m", uri: "https://cdn.test/m.mp4" })).toBe(true);
  });
});
