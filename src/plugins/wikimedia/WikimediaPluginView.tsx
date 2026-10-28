import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import type { AssetInsertPayload, AssetSearchResult } from "../../core/plugins/types";
import {
  useState,
  useEffect,
  useRef,
  dragPayload,
  getActivePage,
  insertRemoteImage,
  updateActivePageElements
} from "../_host";
import { ImageGlyph, SearchGlyph, SpinnerGlyph } from "../_shared/glyphs";
import { getStrings } from "./i18n";
import { createWikimediaProvider } from "./provider";

const wikimediaProvider = createWikimediaProvider(insertRemoteImage);

export interface WikimediaPluginViewProps {
  context: PluginHostContext;
}

const DEFAULT_QUERY = "landscape";

/** Commons is free by policy, but a stray NC/ND tag still deserves the warning. */
const restrictedLicence = (license: string) => /\b(nc|nd)\b/i.test(license);

export function WikimediaPluginView({ context }: WikimediaPluginViewProps) {
  const { ui, docRef, primarySelected, commitSnapshot, notify, dropTopLeft, locale } = context;
  const { Button } = ui;
  const strings = getStrings(locale);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssetSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestSeq = useRef(0);

  const runSearch = async (term: string) => {
    const clean = term.trim();
    if (!clean) return;

    setLoading(true);
    setError(null);
    // Two searches can overlap; whichever was asked for most recently owns the grid.
    const seq = ++requestSeq.current;
    try {
      const res = await wikimediaProvider.search(clean, 24);
      if (seq !== requestSeq.current) return;
      setResults(res);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      const key = err instanceof Error ? err.message : "";
      setResults([]);
      setError(key === "assets.throttled" ? strings.throttled : strings.searchFailed);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    void runSearch(DEFAULT_QUERY);
  }, []);

  const handleSearchSubmit = (e?: Event) => {
    e?.preventDefault();
    void runSearch(query.trim() || DEFAULT_QUERY);
  };

  const handleSelectImage = async (item: AssetSearchResult) => {
    try {
      setPlacingId(item.id);
      const target = primarySelected
        ? { x: primarySelected.x + primarySelected.width + 16, y: primarySelected.y }
        : { x: 0, y: 0 };

      const { element, asset } = await wikimediaProvider.insert(item, target);
      if (!asset) return;

      const nextAssets = [...(docRef.current.assets || []), asset];
      const curPage = getActivePage(docRef.current);

      if (primarySelected) {
        const nextElements = curPage.children.map((el) => {
          if (el.id !== primarySelected.id) return el;
          return {
            ...el,
            fills: [{ type: "image" as const, assetId: asset.id, fit: "cover" as const }]
          };
        });

        const nextDoc = {
          ...updateActivePageElements(docRef.current, nextElements),
          assets: nextAssets
        };
        commitSnapshot(nextDoc);
        notify(strings.filled);
      } else {
        const placed = { ...element, ...dropTopLeft({ width: element.width, height: element.height }) };
        const nextElements = [...curPage.children, placed];
        const nextDoc = {
          ...updateActivePageElements(docRef.current, nextElements),
          assets: nextAssets
        };
        commitSnapshot(nextDoc);
        notify(strings.inserted);
      }
    } catch (err) {
      console.error("Failed to insert Wikimedia image:", err);
    } finally {
      setPlacingId(null);
    }
  };

  return (
    <div className="p-3 flex flex-col gap-2.5 font-sans h-full box-border">
      <form onSubmit={handleSearchSubmit} className="flex items-center gap-1.5 flex-none">
        <div className="relative flex-1 flex items-center">
          <SearchGlyph size={13} className="absolute left-2.5 text-ink-muted pointer-events-none" />
          <input
            type="text"
            name="wikimedia-search"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onCompositionEnd={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing || (e as any).keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                handleSearchSubmit();
              }
            }}
            placeholder={strings.searchPlaceholder}
            className="w-full h-[25px] pl-7 pr-2.5 bg-field text-ink placeholder:text-ink-muted text-ui rounded-ctl border border-rule focus:outline-none focus:border-brand font-sans"
          />
        </div>
        <Button variant="primary" size="field" type="submit" disabled={loading}>
          {loading ? <SpinnerGlyph size={13} className="animate-spin" /> : strings.searchAction}
        </Button>
      </form>

      <div className="relative flex-1 min-h-[240px] overflow-y-auto border border-rule rounded-ctl p-1.5 bg-inset">
        {loading && results.length === 0 ? (
          <div className="py-16 flex flex-col items-center justify-center gap-2 text-ink-muted text-ui">
            <SpinnerGlyph size={18} className="animate-spin text-brand" />
            <span>{strings.searching}</span>
          </div>
        ) : error ? (
          <div className="py-16 flex flex-col items-center justify-center gap-2 text-ink-muted text-ui text-center">
            <ImageGlyph size={24} className="opacity-40" />
            <span>{error}</span>
          </div>
        ) : results.length === 0 ? (
          <div className="py-16 flex flex-col items-center justify-center gap-2 text-ink-muted text-ui text-center">
            <ImageGlyph size={24} className="opacity-40" />
            <span>{strings.noResults}</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {results.map((img) => {
              const payload: AssetInsertPayload = {
                insert: "remote-image",
                result: img
              };

              return (
                <button
                  key={img.id}
                  type="button"
                  draggable={placingId !== img.id}
                  onDragStart={(e) => dragPayload(e, payload)}
                  disabled={placingId === img.id}
                  onClick={() => void handleSelectImage(img)}
                  className="group relative rounded-ctl overflow-hidden border border-rule bg-surface hover:border-brand transition-colors text-left flex flex-col aspect-video cursor-grab active:cursor-grabbing disabled:opacity-50"
                >
                  <img
                    src={img.preview || img.src}
                    alt={img.name}
                    loading="lazy"
                    draggable={false}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-base pointer-events-none select-none"
                  />
                  {img.credit?.license && (
                    <span
                      title={img.credit.license}
                      className={`absolute top-1 right-1 px-1 py-px rounded-sm border border-rule-strong bg-panel text-tag pointer-events-none select-none ${
                        restrictedLicence(img.credit.license) ? "text-ink" : "text-ink-muted"
                      }`}
                    >
                      {img.credit.license}
                    </span>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-1 bg-gradient-to-t from-paper/90 via-paper/50 to-transparent pointer-events-none select-none">
                    <div className="text-micro text-ink truncate font-medium">{img.name}</div>
                    {img.credit?.name && (
                      <div className="text-micro text-ink-muted truncate">{img.credit.name}</div>
                    )}
                  </div>
                  {placingId === img.id && (
                    <div className="absolute inset-0 bg-surface/80 flex items-center justify-center">
                      <SpinnerGlyph size={16} className="animate-spin text-brand" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
