import { useState, useRef, useEffect } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Search, Scissors, Sparkles, Image, Package, Upload, Aperture, Film, Download, Check } from "lucide-react";
import { t } from "../../i18n";
import { installPluginFile, installPluginOnline, removePlugin } from "../../core/plugins/store";
import { fetchPluginCatalog } from "../../core/plugins/catalog";
import type { PluginManifest } from "../../core/plugins/manifest";
import { ContextMenu } from "../context-menu/ContextMenu";
import { usePluginList } from "../plugins/usePluginList";
import { useDismiss } from "../hooks/useDismiss";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";

interface ResourcesPopoverProps {
  onClose: () => void;
  onOpenPlugin: (pluginId: string) => void;
  anchorRef?: { current: HTMLElement | null };
}

interface Row {
  id: string;
  name: string;
  description: string;
  icon: string;
  manifest: PluginManifest;
  installed: boolean;
}

/** Presses on the menu are part of this popover, not a click-away from it. */
const MENU_INSIDE = "[data-plugin-menu]";

export function ResourcesPopover({ onClose, onOpenPlugin, anchorRef }: ResourcesPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [remotePlugins, setRemotePlugins] = useState<PluginManifest[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const pluginList = usePluginList();

  useDismiss(true, onClose, containerRef, anchorRef, [MENU_INSIDE]);

  useEffect(() => {
    inputRef.current?.focus();
    let unmounted = false;
    fetchPluginCatalog()
      .then((cat) => {
        if (!unmounted && Array.isArray(cat.plugins)) {
          setRemotePlugins(cat.plugins);
        }
      })
      .catch(() => {
        // Offline or remote catalog unreachable; local installed plugins remain fully functional
      });
    return () => {
      unmounted = true;
    };
  }, []);

  const installedMap = new Map<string, PluginManifest>(pluginList.items.map((m) => [m.id, m]));

  const installedRows: Row[] = pluginList.items.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon as string,
    manifest,
    installed: true
  }));

  const availableRows: Row[] = remotePlugins
    .filter((manifest) => !installedMap.has(manifest.id))
    .map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      icon: manifest.icon as string,
      manifest,
      installed: false
    }));

  const filterRows = (list: Row[]) => {
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((item) => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
  };

  const filteredInstalled = filterRows(installedRows);
  const filteredAvailable = filterRows(availableRows);

  const pickFile = () => {
    setError(null);
    fileRef.current?.click();
  };

  const installAndOpen = async (file: File) => {
    setInstalling(true);
    setError(null);
    try {
      const manifest = await installPluginFile(file);
      onOpenPlugin(manifest.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleOnlineInstall = async (e: Event, manifest: PluginManifest) => {
    e.stopPropagation();
    setInstallingId(manifest.id);
    setError(null);
    try {
      await installPluginOnline(manifest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingId(null);
    }
  };

  const activate = (row: Row) => {
    if (row.installed) {
      onOpenPlugin(row.id);
      onClose();
    }
  };

  const renderPluginIcon = (icon: string) => {
    switch (icon) {
      case "scissors":
        return <Scissors size={14} className="text-ink-dim group-hover:text-ink transition-colors" />;
      case "aperture":
        return <Aperture size={14} className="text-ink-dim group-hover:text-ink transition-colors" />;
      case "film":
        return <Film size={14} className="text-ink-dim group-hover:text-ink transition-colors" />;
      case "sparkles":
        return <Sparkles size={14} className="text-ink-dim group-hover:text-ink transition-colors" />;
      case "image":
        return <Image size={14} className="text-ink-dim group-hover:text-ink transition-colors" />;
      default:
        return <Package size={14} className="text-ink-dim group-hover:text-ink transition-colors" />;
    }
  };

  return (
    <div className="absolute bottom-11 left-1/2 -translate-x-1/2 z-50">
      <input
        ref={fileRef}
        type="file"
        name="resource-file"
        accept=".js,text/javascript"
        className="hidden"
        onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) void installAndOpen(file);
          (e.target as HTMLInputElement).value = "";
        }}
      />
      <div
        ref={containerRef}
        className="w-80 bg-panel border border-rule-strong shadow-popover rounded-panel overflow-hidden flex flex-col font-sans select-none animate-pop-in"
      >
        {/* Search Input Bar */}
        <div className="p-2 border-b border-rule">
          <div className="relative flex items-center">
            <Search size={13} className="absolute left-2.5 text-ink-muted pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              name="resource-search"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onCompositionEnd={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.isComposing || (e as any).keyCode === 229) return;
              }}
              placeholder={t("resources.searchPlaceholder")}
              className="w-full h-8 pl-8 pr-2.5 bg-field text-ink placeholder:text-ink-muted text-ui rounded-ctl border border-rule focus:outline-none focus:border-brand font-sans"
            />
          </div>
        </div>

        {/* Plugin List */}
        <div className="p-1.5 max-h-80 overflow-y-auto flex flex-col gap-0.5 font-sans">
          {filteredInstalled.length === 0 && filteredAvailable.length === 0 ? (
            <div className="py-6 text-center text-ui text-ink-muted font-sans">
              {query.trim() ? t("resources.noResults") : t("plugins.empty")}
            </div>
          ) : (
            <>
              {filteredInstalled.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {filteredAvailable.length > 0 && (
                    <div className={`px-2 py-1 ${SUB_LABEL_CLASS}`}>{t("plugins.installed")}</div>
                  )}
                  {filteredInstalled.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => activate(item)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, id: item.id });
                      }}
                      className="flex items-center gap-2.5 px-2 py-2 rounded-ctl hover:bg-surface text-left transition-colors group font-sans"
                    >
                      <div className="w-7 h-7 rounded-ctl bg-raised border border-rule flex items-center justify-center flex-none group-hover:border-rule-strong">
                        {renderPluginIcon(item.icon)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-ui font-medium text-ink truncate font-sans">
                          {item.name}
                        </div>
                        <div className="text-ui text-ink-muted truncate font-sans opacity-80">
                          {item.description}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {filteredAvailable.length > 0 && (
                <div className="flex flex-col gap-0.5 mt-1 border-t border-rule pt-1">
                  <div className={`px-2 py-1 ${SUB_LABEL_CLASS}`}>{t("plugins.available")}</div>
                  {filteredAvailable.map((item) => {
                    const isRowInstalling = installingId === item.id;
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-2.5 px-2 py-2 rounded-ctl hover:bg-surface text-left transition-colors group font-sans"
                      >
                        <div className="w-7 h-7 rounded-ctl bg-raised border border-rule flex items-center justify-center flex-none group-hover:border-rule-strong">
                          {renderPluginIcon(item.icon)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-ui font-medium text-ink truncate font-sans">
                            {item.name}
                          </div>
                          <div className="text-ui text-ink-muted truncate font-sans opacity-80">
                            {item.description}
                          </div>
                        </div>
                        <Button
                          variant="boxed"
                          size="text"
                          disabled={isRowInstalling}
                          onClick={(e) => void handleOnlineInstall(e, item.manifest)}
                          className="flex items-center gap-1 shrink-0"
                        >
                          <Download size={12} className="flex-none" />
                          <span>{isRowInstalling ? t("plugins.installing") : t("plugins.install")}</span>
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {error && (
            <div className="px-2 py-1.5 text-ui text-coral font-sans break-words">{error}</div>
          )}

          <button
            type="button"
            disabled={installing}
            onClick={pickFile}
            className="mt-1 flex items-center gap-2 px-2 py-1.5 rounded-ctl text-ui text-ink-muted hover:text-ink hover:bg-surface transition-colors font-sans disabled:opacity-60"
          >
            <Upload size={13} className="flex-none" />
            <span className="truncate">
              {installing ? t("plugins.installing") : t("plugins.loadFile")}
            </span>
          </button>
        </div>
      </div>

      {/* The menu is portalled: the popover is centred with a transform, which
          becomes the containing block for a fixed descendant, and its scrolling
          list would clip a menu that has to reach past the panel's edge. */}
      {menu &&
        createPortal(
          <div data-plugin-menu>
            <ContextMenu
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
              entries={[
                {
                  id: "remove",
                  label: t("plugins.remove"),
                  onSelect: () => {
                    void removePlugin(menu.id);
                    setMenu(null);
                  }
                }
              ]}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
