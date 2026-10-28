import { t } from "../../i18n";

export type MediaKey = "image" | "video" | "html" | "html-code" | "html-import" | "figma-import";
/** Every media key that is answered by a file picker rather than a URL form. */
export type MediaFileKey = Exclude<MediaKey, "html-code">;
export type MediaUrlKey = "image" | "video" | "html" | "html-code";

export interface MediaPickerConfig {
  id: string;
  descriptionKey: string;
  accept: Record<string, string[]>;
}

export const MEDIA_PICKER_CONFIGS: Record<MediaFileKey, MediaPickerConfig> = {
  "figma-import": {
    id: "fish-figma-import",
    descriptionKey: "toolbar.figmaPickerDescription",
    accept: {
      "application/zip": [".zip"]
    }
  },
  "html-import": {
    id: "fish-html-import",
    descriptionKey: "toolbar.htmlImportPickerDescription",
    accept: {
      "text/html": [".html", ".htm"]
    }
  },
  html: {
    id: "fish-html-place",
    descriptionKey: "toolbar.htmlPlacePickerDescription",
    accept: {
      "text/html": [".html", ".htm"]
    }
  },
  image: {
    id: "fish-image-place",
    descriptionKey: "toolbar.imagePickerDescription",
    accept: {
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/svg+xml": [".svg"],
      "image/webp": [".webp"],
      "image/gif": [".gif"]
    }
  },
  video: {
    id: "fish-video-place",
    descriptionKey: "toolbar.videoPickerDescription",
    accept: {
      "video/mp4": [".mp4", ".m4v"],
      "video/webm": [".webm"],
      "video/ogg": [".ogg"],
      "video/quicktime": [".mov"]
    }
  }
};

export const MEDIA_INPUTS: Array<{ key: MediaFileKey; accept: string }> = [
  { key: "image", accept: "image/*" },
  { key: "video", accept: "video/*,.mp4,.webm,.ogg,.mov,.m4v" },
  { key: "html", accept: ".html,.htm" },
  { key: "html-import", accept: ".html,.htm" },
  { key: "figma-import", accept: ".zip,application/zip" }
];

export function mediaPickerOptions(key: MediaFileKey): {
  id: string;
  multiple: false;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
} {
  const config = MEDIA_PICKER_CONFIGS[key];
  return {
    id: config.id,
    multiple: false,
    types: [
      {
        description: t(config.descriptionKey),
        accept: config.accept
      }
    ]
  };
}

export async function pickMediaFile(
  key: MediaFileKey,
  fallbackInput: HTMLInputElement | null,
  onPick: (file: File) => void
): Promise<void> {
  const picker =
    (typeof window !== "undefined" ? (window as any).showOpenFilePicker : undefined) ??
    (globalThis as any).showOpenFilePicker;

  if (typeof picker === "function") {
    try {
      const handles = await picker(mediaPickerOptions(key));
      if (handles && handles[0]?.getFile) {
        const file = await handles[0].getFile();
        onPick(file);
        return;
      }
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return;
    }
  }

  fallbackInput?.click();
}
