import { useState, useRef } from "preact/hooks";
import { Fragment } from "preact";
import type { ComponentType } from "preact";
import {
  MousePointer2,
  Hand,
  Square,
  Circle,
  Minus,
  Frame,
  Type,
  ChevronDown,
  MoveUpRight,
  Hexagon,
  Star,
  Spline,
  Image as ImageIcon,
  Video as VideoIcon,
  Scaling,
  Link2,
  Code,
  ClipboardPaste,
  FileInput,
  Blocks,
  MessageSquare
} from "lucide-react";
import { t } from "../../i18n";
import type { NavToolType, ShapeToolType, ToolType } from "../../core/tools";
import { Button } from "../Button";
import { useDismiss } from "../hooks/useDismiss";
import {
  MENU_ITEM_CLASS,
  MENU_ITEM_ON_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SHORTCUT_CLASS,
  MENU_SURFACE_CLASS
} from "../menu-style";

import { ImageUrlPopover } from "./ImageUrlPopover";
import { ResourcesPopover } from "./ResourcesPopover";
import { ROW_CLASS } from "../row-style";
import {
  MediaKey,
  MediaFileKey,
  MediaUrlKey,
  MEDIA_INPUTS,
  pickMediaFile
} from "./media-picker";

function navTitle(activeTool: ToolType, navTool: NavToolType): string {
  if (activeTool === "scale") return t("scale.title") + " — " + t("scale.leaveHint");
  return navTool === "select" ? t("toolbar.move") : t("toolbar.hand");
}

interface BottomToolbarProps {
  hidden?: boolean;
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  currentNavTool: NavToolType;
  setCurrentNavTool: (tool: NavToolType) => void;
  currentShapeTool: ShapeToolType;
  setCurrentShapeTool: (tool: ShapeToolType) => void;
  isCanvasPanning: boolean;
  setHintMessage: (msg: string) => void;
  onImageFileSelect?: (file: File) => void;
  onImageUrlSelect?: (url: string, signal?: AbortSignal) => Promise<void> | void;
  onVideoFileSelect?: (file: File) => void;
  onVideoUrlSelect?: (url: string, signal?: AbortSignal) => Promise<void> | void;
  onHtmlFileSelect?: (file: File) => void;
  onHtmlUrlSelect?: (url: string, signal?: AbortSignal) => Promise<void> | void;
  /**
   * The same verb as `onHtmlUrlSelect` from a different source: an embed snippet
   * a site's share dialog copied, which is a URL plus the size it asks to be.
   */
  onHtmlCodeSelect?: (code: string) => Promise<void> | void;
  /**
   * A different verb from `onHtmlFileSelect`: that one FRAMES the page live as an
   * `html` element, this one rebuilds it as editable layers on a page of its own.
   */
  onHtmlImportSelect?: (file: File) => void;
  /**
   * The FISH Export plugin's file, handed over as it is picked.
   *
   * There is no dialog in front of this: the file IS the whole input, so the
   * picker is the first and only step. A file that is not an export comes back
   * through the hint toast rather than through a form the user has to fill in
   * again (`useFigmaImport`).
   */
  onFigmaImportSelect?: (file: File) => void;
  /**
   * Toggles the Scale tool. It is the ONE way in from the dock: picking any other
   * tool leaves Scale on its own, because the tool's mode is read back out of
   * `activeTool`, so a second switcher would be a second thing to keep in step.
   */
  onSetScaleTool?: () => void;
  /** Opens a floating plugin panel. */
  onOpenPlugin?: (pluginId: string) => void;
  /** Commits and exits path editing mode when any toolbar tool is activated. */
  onExitPathEdit?: () => void;
}

/**
 * The dock's tool slot: a FIXED 27px box, not `p-1.5` around whatever glyph is
 * inside it. The size used to be arithmetic — padding plus icon — so a slot
 * holding a 12px glyph was 3px shorter than its neighbour and the dock had a
 * visible dip in it. The carets already use `Button size="dock"`, which is the
 * same number; this is the raw-button twin of it, because these slots carry an
 * armed-state background that `Button` does not model.
 */
const DOCK_SLOT_CLASS = "flex-none flex items-center justify-center h-[27px] w-[27px] rounded-dock-ctl";

type DockIcon = ComponentType<{ size?: number; strokeWidth?: number }>;

/**
 * One dock menu at a time — the slot the pointer is over owns the dock, and a
 * menu left open behind another is a menu the user cannot see they have to
 * close. Each caret used to close a different subset of its neighbours, so
 * whether two menus could be open at once depended on which one you opened
 * second.
 */
type DockMenu = "nav" | "shape" | "text" | "media" | "resources";

const SHAPE_TOOLS: Array<{ tool: ShapeToolType; Icon: DockIcon; labelKey: string; shortcut?: string }> = [
  { tool: "rect", Icon: Square, labelKey: "toolbar.rect", shortcut: "R" },
  { tool: "ellipse", Icon: Circle, labelKey: "toolbar.ellipse", shortcut: "O" },
  { tool: "line", Icon: Minus, labelKey: "toolbar.line", shortcut: "L" },
  { tool: "arrow", Icon: MoveUpRight, labelKey: "toolbar.arrow" },
  { tool: "polygon", Icon: Hexagon, labelKey: "toolbar.polygon" },
  { tool: "star", Icon: Star, labelKey: "toolbar.star" },
  { tool: "path", Icon: Spline, labelKey: "toolbar.path", shortcut: "P" }
];

const NAV_TOOLS: Array<{ tool: NavToolType; Icon: DockIcon; labelKey: string; shortcut: string }> = [
  { tool: "select", Icon: MousePointer2, labelKey: "toolbar.move", shortcut: "V" },
  { tool: "hand", Icon: Hand, labelKey: "toolbar.hand", shortcut: "H" }
];

/** `armed` marks the items whose menu row shows which of them is in use. */
const TEXT_ITEMS: Array<{
  Icon: DockIcon;
  labelKey: string;
  tool: "text" | "text-on-path";
  shortcut?: string;
  armed?: boolean;
}> = [
  { Icon: Type, labelKey: "toolbar.text", tool: "text", shortcut: "T" },
  { Icon: Spline, labelKey: "toolbar.textOnPath", tool: "text-on-path", armed: true }
];

const MEDIA_GROUPS: Array<
  Array<{ Icon: DockIcon; labelKey: string; kind: "file" | "url"; key: MediaKey }>
> = [
  [
    { Icon: ImageIcon, labelKey: "toolbar.placeImage", kind: "file", key: "image" },
    { Icon: Link2, labelKey: "toolbar.placeImageUrl", kind: "url", key: "image" }
  ],
  [
    { Icon: VideoIcon, labelKey: "toolbar.placeVideo", kind: "file", key: "video" },
    { Icon: Link2, labelKey: "toolbar.placeVideoUrl", kind: "url", key: "video" }
  ],
  [
    { Icon: ClipboardPaste, labelKey: "toolbar.placeHtml", kind: "file", key: "html" },
    { Icon: Link2, labelKey: "toolbar.placeHtmlUrl", kind: "url", key: "html" },
    { Icon: Code, labelKey: "toolbar.embedHtmlCode", kind: "url", key: "html-code" }
  ],
  [
    { Icon: FileInput, labelKey: "toolbar.importHtml", kind: "file", key: "html-import" },
    { Icon: FileInput, labelKey: "toolbar.importFigma", kind: "file", key: "figma-import" }
  ]
];

export function BottomToolbar({
  hidden = false,
  activeTool,
  setActiveTool,
  currentNavTool,
  setCurrentNavTool,
  currentShapeTool,
  setCurrentShapeTool,
  isCanvasPanning,
  setHintMessage,
  onImageFileSelect,
  onImageUrlSelect,
  onVideoFileSelect,
  onVideoUrlSelect,
  onHtmlFileSelect,
  onHtmlUrlSelect,
  onHtmlCodeSelect,
  onHtmlImportSelect,
  onFigmaImportSelect,
  onSetScaleTool,
  onOpenPlugin,
  onExitPathEdit
}: BottomToolbarProps) {
  const [openMenu, setOpenMenu] = useState<DockMenu | null>(null);
  const [mediaPopover, setMediaPopover] = useState<MediaUrlKey | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const htmlFileInputRef = useRef<HTMLInputElement>(null);
  const htmlImportInputRef = useRef<HTMLInputElement>(null);
  const figmaImportInputRef = useRef<HTMLInputElement>(null);

  const navMenuRef = useRef<HTMLDivElement>(null);
  const navAnchorRef = useRef<HTMLDivElement>(null);
  const shapeMenuRef = useRef<HTMLDivElement>(null);
  const shapeAnchorRef = useRef<HTMLDivElement>(null);
  const textMenuRef = useRef<HTMLDivElement>(null);
  const textAnchorRef = useRef<HTMLDivElement>(null);
  const mediaMenuRef = useRef<HTMLDivElement>(null);
  const mediaAnchorRef = useRef<HTMLDivElement>(null);
  const resourcesAnchorRef = useRef<HTMLDivElement>(null);

  const closeMenus = () => setOpenMenu(null);
  const toggleMenu = (name: DockMenu) => setOpenMenu((prev) => (prev === name ? null : name));

  useDismiss(openMenu === "nav", closeMenus, navMenuRef, navAnchorRef);
  useDismiss(openMenu === "shape", closeMenus, shapeMenuRef, shapeAnchorRef);
  useDismiss(openMenu === "text", closeMenus, textMenuRef, textAnchorRef);
  useDismiss(openMenu === "media", closeMenus, mediaMenuRef, mediaAnchorRef);

  const fileInputs: Record<MediaFileKey, { current: HTMLInputElement | null }> = {
    image: imageFileInputRef,
    video: videoFileInputRef,
    html: htmlFileInputRef,
    "html-import": htmlImportInputRef,
    "figma-import": figmaImportInputRef
  };

  const mediaFileSinks: Record<MediaFileKey, ((file: File) => void) | undefined> = {
    image: onImageFileSelect,
    video: onVideoFileSelect ?? onImageFileSelect,
    html: onHtmlFileSelect,
    "html-import": onHtmlImportSelect,
    "figma-import": onFigmaImportSelect
  };

  const mediaUrlSinks: Record<MediaUrlKey, (value: string, signal?: AbortSignal) => Promise<void> | void> = {
    image: (url, signal) => onImageUrlSelect?.(url, signal),
    video: (url, signal) => onVideoUrlSelect?.(url, signal),
    html: (url, signal) => onHtmlUrlSelect?.(url, signal),
    "html-code": (code) => onHtmlCodeSelect?.(code)
  };

  const mediaPopoverProps: Record<MediaUrlKey, { title: string; placeholder: string; errorMessage: string; multiline?: boolean }> = {
    image: {
      title: t("toolbar.insertImageUrl"),
      placeholder: t("toolbar.imageUrlPlaceholder"),
      errorMessage: t("toolbar.imageUrlError")
    },
    video: {
      title: t("toolbar.insertVideoUrl"),
      placeholder: t("toolbar.videoUrlPlaceholder"),
      errorMessage: t("toolbar.videoUrlError")
    },
    html: {
      title: t("toolbar.insertHtmlUrl"),
      placeholder: t("toolbar.htmlUrlPlaceholder"),
      errorMessage: t("toolbar.htmlUrlError")
    },
    "html-code": {
      title: t("toolbar.insertHtmlCode"),
      placeholder: t("toolbar.htmlCodePlaceholder"),
      errorMessage: t("toolbar.htmlCodeError"),
      multiline: true
    }
  };

  const selectTool = (tool: ToolType) => {
    onExitPathEdit?.();
    setActiveTool(tool);
  };

  const triggerScaleTool = () => {
    onExitPathEdit?.();
    onSetScaleTool?.();
  };

  const runMedia = (item: { kind: "file" | "url"; key: MediaKey }) => {
    onExitPathEdit?.();
    if (item.kind === "file") {
      const fileKey = item.key as MediaFileKey;
      if (fileKey === "figma-import") {
        setHintMessage(t("toolbar.figmaPickerHint"));
        setTimeout(() => setHintMessage(""), 6000);
      } else if (fileKey === "html-import") {
        setHintMessage(t("toolbar.htmlImportPickerHint"));
        setTimeout(() => setHintMessage(""), 6000);
      }
      const sink = mediaFileSinks[fileKey];
      if (sink) {
        pickMediaFile(fileKey, fileInputs[fileKey].current, sink);
      } else {
        fileInputs[fileKey].current?.click();
      }
      setTimeout(closeMenus, 0);
      return;
    }
    closeMenus();
    setMediaPopover(item.key as MediaUrlKey);
  };

  const runTextItem = (item: (typeof TEXT_ITEMS)[number]) => {
    closeMenus();
    selectTool(item.tool);
    if (item.tool === "text-on-path") {
      setHintMessage("Click any shape on canvas to attach text to its path.");
      setTimeout(() => setHintMessage(""), 4000);
    }
  };

  const isNavActive = activeTool === "select" || activeTool === "hand" || activeTool === "scale" || isCanvasPanning;
  const isFrameActive = activeTool === "frame";
  const isShapeActive = activeTool === currentShapeTool;
  const isTextActive = activeTool === "text";
  const ShapeIcon = SHAPE_TOOLS.find((s) => s.tool === currentShapeTool)?.Icon;
  const activeMediaPopover = mediaPopover ? mediaPopoverProps[mediaPopover] : null;

  return (
    <div
      data-ui-panel="dock"
      role="toolbar"
      aria-label={t("toolbar.dock")}
      className={`fixed bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-surface rounded-dock px-2 py-1 border border-rule-strong z-40 transition-[transform,opacity] duration-slide ease-slide ${hidden ? "translate-y-[200%] opacity-0 pointer-events-none" : "translate-y-0 opacity-100"
        }`}
    >
      {/* Slot 1: Move / Hand / Scale. One group because one question — "how do I
          move this" — has three answers, and a separate button for the third made
          the dock read as four unrelated tools. */}
      <div ref={navAnchorRef} className="relative flex items-center">
        <button
          onClick={() => (activeTool === "scale" ? triggerScaleTool() : selectTool(currentNavTool))}
          data-nav-tool="true"
          data-nav-icon={activeTool === "scale" ? "scale" : currentNavTool}
          className={`${DOCK_SLOT_CLASS} transition-colors duration-micro ease-snap ${isNavActive
            ? "bg-brand text-brand-ink font-medium"
            : "text-ink-dim hover:text-ink"
            }`}
          title={navTitle(activeTool, currentNavTool)}
        >
          {/* The button shows the tool that is ON, not the slot's default. Scale is
              the case that needs it: it is entered from the menu and the caret, so a
              slot still showing the arrow would leave the user with nothing on screen
              saying which of the three is armed (Figma swaps the icon for the same
              reason). Leaving Scale puts the arrow back, because the slot's default
              is the Move tool and that is where Enter returns to. */}
          {activeTool === "scale" ? <Scaling size={15} strokeWidth={isNavActive ? 2.1 : 2} /> : currentNavTool === "select" ? <MousePointer2 size={15} strokeWidth={isNavActive ? 2.1 : 2} /> : <Hand size={15} strokeWidth={isNavActive ? 2.1 : 2} />}
        </button>
        <Button
          size="dock"
          onClick={() => toggleMenu("nav")}
          data-nav-caret="true"
          title={t("toolbar.navMenu")}
          aria-label={t("toolbar.navMenu")}
        >
          <ChevronDown size={11} />
        </Button>

        {openMenu === "nav" && (
          <div ref={navMenuRef} data-nav-menu="true" className={`absolute bottom-11 left-0 ${MENU_SURFACE_CLASS}`}>
            {NAV_TOOLS.map(({ tool, Icon, labelKey, shortcut }) => (
              <button
                key={tool}
                data-nav-item={tool}
                onClick={() => {
                  setCurrentNavTool(tool);
                  selectTool(tool);
                  closeMenus();
                }}
                className={`${MENU_ITEM_CLASS} justify-between ${activeTool === tool ? MENU_ITEM_ON_CLASS : ""}`}
              >
                <div className={ROW_CLASS}>
                  <Icon size={13} />
                  <span>{t(labelKey)}</span>
                </div>
                <span className={MENU_SHORTCUT_CLASS}>{shortcut}</span>
              </button>
            ))}
            <div className={MENU_SEPARATOR_CLASS} />
            {/* A temporary mode, and it says so: Enter leaves it, and so does
                picking anything else, so it needs no place of its own to sit in. */}
            <button
              onClick={() => {
                triggerScaleTool();
                closeMenus();
              }}
              data-scale-tool="true"
              className={`${MENU_ITEM_CLASS} justify-between ${activeTool === "scale" ? MENU_ITEM_ON_CLASS : ""}`}
              title={t("scale.leaveHint")}
            >
              <div className={ROW_CLASS}>
                <Scaling size={13} />
                <span>{t("scale.title")}</span>
              </div>
              <span className={MENU_SHORTCUT_CLASS}>K</span>
            </button>
          </div>
        )}
      </div>

      <div className="w-px h-4 bg-rule-strong mx-1.5" />

      {/* Slot 2: Frame Tool */}
      <button
        data-tool="frame"
        onClick={() => selectTool("frame")}
        className={`${DOCK_SLOT_CLASS} transition-colors duration-micro ease-snap ${isFrameActive ? "bg-brand text-brand-ink font-medium" : "text-ink-dim hover:text-ink"
          }`}
        title={t("toolbar.frame")}
        aria-label={t("toolbar.frame")}
      >
        <Frame size={15} strokeWidth={isFrameActive ? 2.1 : 2} />
      </button>

      <div className="w-px h-4 bg-rule-strong mx-1.5" />

      {/* Slot 3: Shapes Tool with Dropdown */}
      <div ref={shapeAnchorRef} className="relative flex items-center">
        <button
          data-tool="shape"
          onClick={() => selectTool(currentShapeTool)}
          className={`${DOCK_SLOT_CLASS} transition-colors duration-micro ease-snap ${isShapeActive ? "bg-brand text-brand-ink font-medium" : "text-ink-dim hover:text-ink"
            }`}
          title={t("toolbar.shapeTool")}
          aria-label={t("toolbar.shapeTool")}
        >
          {ShapeIcon && <ShapeIcon size={15} strokeWidth={isShapeActive ? 2.1 : 2} />}
        </button>
        <Button
          size="dock"
          data-shape-caret="true"
          onClick={() => toggleMenu("shape")}
          title={t("toolbar.shapeMenu")}
          aria-label={t("toolbar.shapeMenu")}
        >
          <ChevronDown size={11} />
        </Button>

        {openMenu === "shape" && (
          <div ref={shapeMenuRef} className={`absolute bottom-11 left-0 ${MENU_SURFACE_CLASS}`}>
            {SHAPE_TOOLS.map(({ tool, Icon, labelKey, shortcut }) => (
              <button
                key={tool}
                data-shape-item={tool}
                onClick={() => {
                  setCurrentShapeTool(tool);
                  selectTool(tool);
                  closeMenus();
                }}
                className={`${MENU_ITEM_CLASS} justify-between`}
              >
                <div className={ROW_CLASS}>
                  <Icon size={13} />
                  <span>{t(labelKey)}</span>
                </div>
                {shortcut && <span className={MENU_SHORTCUT_CLASS}>{shortcut}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="w-px h-4 bg-rule-strong mx-1.5" />

      {/* Slot 4: Typography Tool with Dropdown */}
      <div ref={textAnchorRef} className="relative flex items-center">
        <button
          onClick={() => selectTool("text")}
          className={`${DOCK_SLOT_CLASS} transition-colors duration-micro ease-snap ${isTextActive ? "bg-brand text-brand-ink font-medium" : "text-ink-dim hover:text-ink"
            }`}
          title={t("toolbar.text")}
          aria-label={t("toolbar.text")}
        >
          <Type size={15} strokeWidth={isTextActive ? 2.1 : 2} />
        </button>
        <Button
          size="dock"
          onClick={() => toggleMenu("text")}
          title={t("toolbar.textMenu")}
          aria-label={t("toolbar.textMenu")}
        >
          <ChevronDown size={11} />
        </Button>

        {openMenu === "text" && (
          <div ref={textMenuRef} className={`absolute bottom-11 left-0 ${MENU_SURFACE_CLASS}`}>
            {TEXT_ITEMS.map((item) => (
              <button
                key={item.tool}
                onClick={() => runTextItem(item)}
                className={`${MENU_ITEM_CLASS} ${item.shortcut ? "justify-between" : ""} ${item.armed && activeTool === item.tool ? MENU_ITEM_ON_CLASS : ""}`}
              >
                <div className={ROW_CLASS}>
                  <item.Icon size={13} />
                  <span>{t(item.labelKey)}</span>
                </div>
                {item.shortcut && <span className={MENU_SHORTCUT_CLASS}>{item.shortcut}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="w-px h-4 bg-rule-strong mx-1.5" />

      {/* Slot 5: Media Tool (Image / Video) */}
      <div ref={mediaAnchorRef} className="relative flex items-center">
        <button
          onClick={() => toggleMenu("media")}
          className={`${DOCK_SLOT_CLASS} transition-colors duration-micro ease-snap ${openMenu === "media" ? "bg-raised text-ink" : "text-ink-dim hover:text-ink"
            }`}
          title={t("toolbar.media")}
          aria-label={t("toolbar.media")}
        >
          <ImageIcon size={15} />
        </button>
        <Button
          size="dock"
          onClick={() => toggleMenu("media")}
          title={t("toolbar.mediaMenu")}
          aria-label={t("toolbar.mediaMenu")}
        >
          <ChevronDown size={11} />
        </Button>

        {openMenu === "media" && (
          <div ref={mediaMenuRef} className={`absolute bottom-11 left-0 ${MENU_SURFACE_CLASS} min-w-[200px]`}>
            {MEDIA_GROUPS.map((group, index) => (
              <Fragment key={index}>
                {index > 0 && <div className={MENU_SEPARATOR_CLASS} />}
                {group.map((item) => (
                  <button
                    key={item.key + item.labelKey}
                    onClick={() => runMedia(item)}
                    className={`${MENU_ITEM_CLASS} justify-between`}
                  >
                    <div className={ROW_CLASS}>
                      <item.Icon size={13} />
                      <span>{t(item.labelKey)}</span>
                    </div>
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        )}

        {activeMediaPopover && (
          <ImageUrlPopover
            title={activeMediaPopover.title}
            placeholder={activeMediaPopover.placeholder}
            errorMessage={activeMediaPopover.errorMessage}
            multiline={activeMediaPopover.multiline}
            onSubmit={async (value, signal) => {
              await mediaUrlSinks[mediaPopover as MediaUrlKey](value, signal);
            }}
            onClose={() => setMediaPopover(null)}
          />
        )}
      </div>

      <div className="w-px h-4 bg-rule-strong mx-1.5" />

      {/* Slot 6: Comments */}
      <button
        data-tool="comment"
        onClick={() => selectTool("comment")}
        className={`${DOCK_SLOT_CLASS} transition-colors duration-micro ease-snap ${
          activeTool === "comment" ? "bg-brand text-brand-ink font-medium" : "text-ink-dim hover:text-ink"
        }`}
        title={`${t("toolbar.comment")} (C)`}
        aria-label={`${t("toolbar.comment")} (C)`}
      >
        <MessageSquare size={15} />
      </button>

      <div className="w-px h-4 bg-rule-strong mx-1.5" />

      {/* Slot 7: Resources (Plugins & Assets) */}
      <div ref={resourcesAnchorRef} className="relative flex items-center">
        <button
          data-tool="resources"
          onClick={() => toggleMenu("resources")}
          className={`${DOCK_SLOT_CLASS} transition-colors duration-micro ease-snap ${openMenu === "resources" ? "bg-brand text-brand-ink font-medium" : "text-ink-dim hover:text-ink"
            }`}
          title={t("toolbar.resources")}
          aria-label={t("toolbar.resources")}
        >
          <Blocks size={15} />
        </button>

        {openMenu === "resources" && (
          <ResourcesPopover
            anchorRef={resourcesAnchorRef}
            onClose={closeMenus}
            onOpenPlugin={(pluginId) => {
              onExitPathEdit?.();
              onOpenPlugin?.(pluginId);
              closeMenus();
            }}
          />
        )}
      </div>

      <div>
        {MEDIA_INPUTS.map(({ key, accept }) => (
          <input
            key={key}
            ref={fileInputs[key]}
            type="file"
            name={`media-file-${key}`}
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const files = (e.currentTarget as HTMLInputElement).files;
              if (files && files[0]) mediaFileSinks[key]?.(files[0]);
              (e.currentTarget as HTMLInputElement).value = "";
            }}
          />
        ))}
      </div>

    </div>
  );
}
