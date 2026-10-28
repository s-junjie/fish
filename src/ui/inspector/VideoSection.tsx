import { useState, useEffect, useCallback } from "preact/hooks";
import { DesignDocument, DesignElement, VideoElement } from "../../core/dsl/types";
import { embedExternalVideoAsset, isIframeVideoUrl } from "../../core/interactions/video-loader";
import { formatDuration } from "../duration-format";
import { Section } from "./SectionHeader";
import { SUB_LABEL_CLASS } from "../label-tier";
import { Button } from "../Button";
import { CheckRow } from "../CheckRow";
import { t } from "../../i18n";
import {
  Play,
  Pause,
  Globe,
  Package,
  Loader2,
  Volume2,
  VolumeX,
  Repeat,
  Tv
} from "lucide-react";
import { ROW_CLASS, ROW_DENSE_CLASS } from "../row-style";

interface VideoSectionProps {
  primarySelected: DesignElement;
  docRef: { current: DesignDocument };
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
  onCommitSnapshot: (doc: DesignDocument) => void;
}

export function VideoSection({
  primarySelected,
  docRef,
  onMutate,
  onCommitSnapshot
}: VideoSectionProps) {
  if (primarySelected.type !== "video") return null;

  const vel = primarySelected as VideoElement;
  const asset = (docRef.current.assets || []).find((a) => a.id === vel.assetId);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const isExternal = Boolean(
    asset?.uri && (asset.uri.startsWith("http://") || asset.uri.startsWith("https://"))
  );
  const isIframe = Boolean(asset?.uri && isIframeVideoUrl(asset.uri));

  const originalW = asset?.width || 0;
  const originalH = asset?.height || 0;
  const durationSec = asset?.duration || 0;

  // Track live video element on canvas (for direct video files)
  useEffect(() => {
    if (isIframe) return;
    const video = document.querySelector(`video[data-video-id="${vel.id}"]`) as HTMLVideoElement | null;
    if (!video) return;

    setIsPlaying(!video.paused);
    setCurrentTime(video.currentTime || 0);

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(video.currentTime || 0);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", onTimeUpdate);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [vel.id, isIframe]);

  const togglePlay = useCallback(() => {
    const video = document.querySelector(`video[data-video-id="${vel.id}"]`) as HTMLVideoElement | null;
    if (!video) return;
    if (video.paused) {
      video.play().catch((err) => {
        console.warn("Playback failed:", err);
      });
    } else {
      video.pause();
    }
  }, [vel.id]);

  const handleEmbed = async () => {
    if (!asset || !isExternal || isIframe || isEmbedding) return;
    setIsEmbedding(true);
    try {
      const embedded = await embedExternalVideoAsset(asset);
      const nextAssets = (docRef.current.assets || []).map((a) => (a.id === asset.id ? embedded : a));
      onCommitSnapshot({ ...docRef.current, assets: nextAssets });
    } catch (err) {
      console.error("Failed to embed video asset:", err);
    } finally {
      setIsEmbedding(false);
    }
  };

  return (
    <Section id="video" title={t("video.title")} data-inspector-section="video">

      {/* Playback Row */}
      {isIframe ? (
        <div className="flex items-center justify-between p-1.5 bg-raised/50 rounded-ctl border border-rule">
          <div className="flex items-center gap-1.5 text-ink text-meta font-medium">
            <Tv size={12} className="text-brand" />
            <span>{asset?.name || "Web Video"}</span>
          </div>
          <span className="text-micro font-mono text-ink-dim">Iframe</span>
        </div>
      ) : (
        <div className="flex items-center justify-between p-1.5 bg-raised/50 rounded-ctl border border-rule">
          <div className={ROW_CLASS}>
            {/* A transport toggle is a ROW ACTION, not the committing action of
                its surface, so it never wears `primary` — the solid brand fill is
                reserved for one action per surface. `boxed` is the reading that
                says "pressable" (the hairline) while the video is idle, and
                `ghost` steps back once it is running and the label already reads
                "Pause". `h-5 px-2` is `size="text"`'s box spelled out, because
                `boxed` owns its own box and drops the size's class. */}
            <Button
              variant={isPlaying ? "ghost" : "boxed"}
              size="text"
              onClick={togglePlay}
              className="font-medium gap-1 h-5 px-2"
              title={isPlaying ? t("video.pause") : t("video.play")}
            >
              {isPlaying ? (
                <>
                  <Pause size={11} className="fill-current" />
                  <span>{t("video.pause")}</span>
                </>
              ) : (
                <>
                  <Play size={11} className="fill-current ml-0.5" />
                  <span>{t("video.play")}</span>
                </>
              )}
            </Button>

            <span className="font-mono text-micro text-ink-muted">
              {formatDuration(currentTime)} / {formatDuration(durationSec)}
            </span>
          </div>

          <div className={ROW_DENSE_CLASS}>
            {/* Loop toggle */}
            <button
              type="button"
              onClick={() => onMutate((el) => ({ ...el, loop: (el as VideoElement).loop === false ? true : false }), true)}
              className={`p-1 rounded-ctl transition-colors duration-micro ease-snap ${
                vel.loop !== false ? "text-brand bg-brand-wash font-medium" : "text-ink-muted hover:text-ink hover:bg-raised"
              }`}
              title={t("video.loop")}
              aria-label={t("video.loop")}
            >
              <Repeat size={12} />
            </button>

            {/* Muted toggle */}
            <button
              type="button"
              onClick={() => onMutate((el) => ({ ...el, muted: (el as VideoElement).muted === false ? true : false }), true)}
              className={`p-1 rounded-ctl transition-colors duration-micro ease-snap ${
                vel.muted !== false ? "text-brand bg-brand-wash font-medium" : "text-ink-muted hover:text-ink hover:bg-raised"
              }`}
              title={t("video.muted")}
              aria-label={t("video.muted")}
            >
              {vel.muted !== false ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
          </div>
        </div>
      )}

      {/* Embed action if external direct video file */}
      {isExternal && !isIframe && (
        <div className="flex items-center justify-end px-0.5">
          <Button
            variant="ghost"
            size="text"
            onClick={handleEmbed}
            disabled={isEmbedding}
            className="text-micro font-medium"
          >
            {isEmbedding ? (
              <>
                <Loader2 size={10} className="animate-spin mr-1 text-brand" />
                {t("video.embedding")}
              </>
            ) : (
              t("video.embedAction")
            )}
          </Button>
        </div>
      )}

      {/* Original Size & Duration Card */}
      <div className="flex items-center justify-between p-1.5 bg-raised/40 rounded-ctl border border-rule">
        <span className={SUB_LABEL_CLASS}>{t("video.originalSize")}</span>
        <div className="flex items-center gap-2 font-mono text-meta text-ink-dim">
          <span>{originalW > 0 && originalH > 0 ? `${originalW} × ${originalH}` : "—"}</span>
          {durationSec > 0 && <span className="text-micro text-ink-muted">· {formatDuration(durationSec)}</span>}
        </div>
      </div>

      {/* Native Controls Checkbox (Left-aligned CheckRow matching clipContent) */}
      {!isIframe && (
        <div className="pt-0.5 px-0.5">
          <CheckRow
            testId="video-controls"
            checked={vel.controls !== false}
            onChange={(checked) => onMutate((el) => ({ ...el, controls: checked }), true)}
            label={t("video.controls")}
          />
        </div>
      )}

      {/* Autoplay in Presentation Mode Checkbox */}
      <div className="pt-0.5 px-0.5">
        <CheckRow
          testId="video-autoplay"
          checked={vel.autoplay === true}
          onChange={(checked) => onMutate((el) => ({ ...el, autoplay: checked }), true)}
          label={t("video.autoplay")}
        />
      </div>
    </Section>
  );
}
