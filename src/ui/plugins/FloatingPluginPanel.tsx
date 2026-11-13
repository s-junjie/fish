import type { ComponentChildren } from "preact";
import type { PluginResizeMode, PluginAttribution } from "../../core/plugins/plugin-contract";
import { FloatingWindow } from "../FloatingWindow";

interface FloatingPluginPanelProps {
  pluginId?: string;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  initialX?: number;
  initialY?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resize?: PluginResizeMode;
  attribution?: PluginAttribution | PluginAttribution[];
}

export function FloatingPluginPanel({
  pluginId,
  title,
  onClose,
  children,
  initialX = 120,
  initialY = 80,
  width = 340,
  height,
  minWidth = 280,
  minHeight = 240,
  resize = "none",
  attribution
}: FloatingPluginPanelProps) {
  const attributionList = attribution
    ? Array.isArray(attribution)
      ? attribution
      : [attribution]
    : [];

  return (
    <FloatingWindow
      title={title}
      onClose={onClose}
      initialX={initialX}
      initialY={initialY}
      width={width}
      height={height}
      minWidth={minWidth}
      minHeight={minHeight}
      resize={resize}
    >
      <div
        data-fish-plugin={pluginId}
        className="flex-1 overflow-y-auto min-h-0 relative"
      >
        {children}
      </div>

      {attributionList.length > 0 && (
        <div
          className={`px-3 py-1.5 border-t border-rule flex items-center justify-end gap-2 flex-none bg-surface/30 select-none ${
            resize === "both" ? "pr-5" : ""
          }`}
        >
          {attributionList.map((attr, idx) => (
            <span key={attr.url} className="inline-flex items-center gap-2">
              {idx > 0 && <span className="text-ink-muted/40 select-none">·</span>}
              <a
                href={attr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="relative z-10 text-micro text-ink-muted hover:text-ink transition-colors"
              >
                {attr.name}
              </a>
            </span>
          ))}
        </div>
      )}
    </FloatingWindow>
  );
}
