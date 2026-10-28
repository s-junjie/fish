import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import type { AssetSearchResult, AssetInsertPayload } from "../../core/plugins/types";
import {
  useState,
  useEffect,
  dragPayload,
  getActivePage,
  lucideProvider,
  remixProvider,
  updateActivePageElements
} from "../_host";
import { SearchGlyph, SpinnerGlyph } from "../_shared/glyphs";
import { iconsStrings as i18n } from "./i18n";

export interface IconsPluginViewProps {
  context: PluginHostContext;
}

export function IconsPluginView({ context }: IconsPluginViewProps) {
  const { ui, docRef, primarySelected, commitSnapshot, notify, dropTopLeft } = context;
  const { Button } = ui;

  const [providerType, setProviderType] = useState<"lucide" | "remix">("lucide");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssetSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const activeProvider = providerType === "lucide" ? lucideProvider : remixProvider;

  const executeSearch = async (q: string) => {
    setLoading(true);
    try {
      const res = await activeProvider.search(q, 60);
      setResults(res);
    } catch (err) {
      console.error("Icon search failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await activeProvider.search(query, 60);
        if (active) setResults(res);
      } catch (err) {
        console.error("Icon search failed:", err);
      } finally {
        if (active) setLoading(false);
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, providerType]);

  const handleInsertIcon = async (item: AssetSearchResult) => {
    try {
      // Beside the selection when there is one; otherwise centred on the canvas
      // the user is looking at. The provider's box is the 24×24 set viewBox, so
      // that is the size the centre is measured against.
      const target = primarySelected
        ? { x: primarySelected.x + primarySelected.width + 16, y: primarySelected.y }
        : dropTopLeft({ width: 24, height: 24 });

      const insertRes = await activeProvider.insert(item, target);
      const newElement = insertRes.element;

      const curPage = getActivePage(docRef.current);
      const nextDoc = updateActivePageElements(docRef.current, [...curPage.children, newElement]);

      commitSnapshot(nextDoc);
      notify(i18n.inserted);
    } catch (err) {
      console.error("Failed to insert icon:", err);
    }
  };

  return (
    <div className="p-3 flex flex-col gap-2.5 font-sans h-full box-border">
      {/* Search Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          executeSearch(query);
        }}
        className="relative flex items-center flex-none"
      >
        <SearchGlyph size={13} className="absolute left-2.5 text-ink-muted pointer-events-none" />
        <input
          type="text"
          name="icon-search"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onCompositionEnd={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.isComposing || (e as any).keyCode === 229) return;
          }}
          placeholder={i18n.searchPlaceholder}
          className="w-full h-[25px] pl-7 pr-2.5 bg-field text-ink placeholder:text-ink-muted text-ui rounded-ctl border border-rule focus:outline-none focus:border-brand font-sans"
        />
      </form>

      {/* Set Switcher Bar */}
      <div className="flex items-center gap-1 bg-surface p-0.5 rounded-ctl border border-rule flex-none">
        <button
          type="button"
          onClick={() => setProviderType("lucide")}
          className={`flex-1 h-6 rounded-ctl text-ui transition-colors ${
            providerType === "lucide"
              ? "bg-field text-ink font-medium shadow-sm"
              : "text-ink-muted hover:text-ink"
          }`}
        >
          {i18n.sourceLucide}
        </button>
        <button
          type="button"
          onClick={() => setProviderType("remix")}
          className={`flex-1 h-6 rounded-ctl text-ui transition-colors ${
            providerType === "remix"
              ? "bg-field text-ink font-medium shadow-sm"
              : "text-ink-muted hover:text-ink"
          }`}
        >
          {i18n.sourceRemix}
        </button>
      </div>

      {/* Icon Results Grid */}
      <div className="relative flex-1 min-h-[220px] overflow-y-auto border border-rule rounded-ctl p-1.5 bg-inset">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-ink-muted text-ui">
            <SpinnerGlyph size={16} className="animate-spin text-brand" />
            <span>{i18n.searching}</span>
          </div>
        ) : results.length === 0 ? (
          <div className="py-12 text-center text-ink-muted text-ui">
            {i18n.noResults}
          </div>
        ) : (
          <div className="grid grid-cols-6 gap-1">
            {results.map((icon) => {
              const render = icon.iconRender;
              const isFill = render?.mode === "fill";
              const paths = icon.iconPaths || [];
              const payload: AssetInsertPayload = {
                providerId: providerType === "lucide" ? "lucide" : "ri",
                result: icon
              };

              return (
                <button
                  key={icon.id}
                  type="button"
                  draggable={true}
                  onDragStart={(e) => dragPayload(e, payload)}
                  onClick={() => handleInsertIcon(icon)}
                  title={icon.name}
                  className="flex items-center justify-center w-10 h-10 rounded-ctl bg-surface border border-transparent hover:border-brand hover:bg-raised transition-colors group cursor-grab active:cursor-grabbing"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-5 h-5 text-ink-dim group-hover:text-ink transition-colors pointer-events-none"
                  >
                    {paths.map((d, idx) => (
                      <path
                        key={idx}
                        d={d}
                        fill={isFill ? "currentColor" : "none"}
                        stroke={isFill ? "none" : "currentColor"}
                        strokeWidth={render?.strokeWidth ?? 2}
                        strokeLinecap={render?.cap ?? "round"}
                        strokeLinejoin={render?.join ?? "round"}
                      />
                    ))}
                  </svg>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
