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
import { clearApiKey, readApiKey, saveApiKey } from "./api-key";
import { getStrings, type PixabayPluginStrings } from "./i18n";
import { PixabayError, searchPixabay } from "./provider";

export interface PixabayPluginViewProps {
  context: PluginHostContext;
}

const DEFAULT_QUERY = "landscape";
const API_KEY_URL = "https://pixabay.com/api/docs/";

function messageFor(err: unknown, strings: PixabayPluginStrings): string {
  if (err instanceof PixabayError) {
    if (err.code === "invalidKey") return strings.invalidKey;
    if (err.code === "throttled") return strings.throttled;
  }
  return strings.searchFailed;
}

export function PixabayPluginView({ context }: PixabayPluginViewProps) {
  const { ui, docRef, primarySelected, commitSnapshot, notify, dropTopLeft, locale } = context;
  const { Button } = ui;
  const strings = getStrings(locale);

  const [apiKey, setApiKey] = useState(() => readApiKey());
  const [draft, setDraft] = useState(() => readApiKey());
  const [showSettings, setShowSettings] = useState(() => !readApiKey());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssetSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestSeq = useRef(0);

  const runSearch = async (term: string, key: string = apiKey) => {
    const clean = term.trim();
    if (!clean || !key) return;

    setLoading(true);
    setError(null);
    // Two searches can overlap; whichever was asked for most recently owns the grid.
    const seq = ++requestSeq.current;
    try {
      const res = await searchPixabay(key, clean, 24);
      if (seq !== requestSeq.current) return;
      setResults(res);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setResults([]);
      setError(messageFor(err, strings));
      if (err instanceof PixabayError && err.code === "invalidKey") setShowSettings(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (apiKey) void runSearch(DEFAULT_QUERY, apiKey);
  }, []);

  const handleSearchSubmit = (e?: Event) => {
    e?.preventDefault();
    void runSearch(query.trim() || DEFAULT_QUERY);
  };

  const handleSaveKey = (e?: Event) => {
    e?.preventDefault();
    const clean = draft.trim();
    if (!clean) return;
    saveApiKey(clean);
    setApiKey(clean);
    setDraft(clean);
    setError(null);
    setShowSettings(false);
    notify(strings.keySaved);
    void runSearch(DEFAULT_QUERY, clean);
  };

  const handleClearKey = () => {
    clearApiKey();
    setApiKey("");
    setDraft("");
    setResults([]);
    setError(null);
    setShowSettings(true);
    notify(strings.keyCleared);
  };

  const handleSelectImage = async (item: AssetSearchResult) => {
    try {
      setPlacingId(item.id);
      const target = primarySelected
        ? { x: primarySelected.x + primarySelected.width + 16, y: primarySelected.y }
        : { x: 0, y: 0 };

      const { element, asset } = await insertRemoteImage(item, target);
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
      console.error("Failed to insert Pixabay image:", err);
    } finally {
      setPlacingId(null);
    }
  };

  if (showSettings) {
    return (
      <div className="p-3 flex flex-col gap-3 font-sans h-full box-border overflow-y-auto">
        <div className="flex items-center justify-between gap-2 flex-none">
          <div className="text-displaySm text-ink">{strings.keyTitle}</div>
          {apiKey && (
            <Button variant="ghost" size="text" onClick={() => setShowSettings(false)}>
              {strings.keyBack}
            </Button>
          )}
        </div>

        <div className="text-ui text-ink-dim">{strings.keyIntro}</div>

        <form onSubmit={handleSaveKey} className="flex flex-col gap-2 flex-none">
          <input
            type="password"
            name="pixabay-api-key"
            value={draft}
            aria-label={strings.keyTitle}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing || (e as any).keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                handleSaveKey();
              }
            }}
            placeholder={strings.keyPlaceholder}
            className="w-full h-[25px] px-2 bg-inset text-ink placeholder:text-ink-muted text-ui rounded-ctl border border-rule focus:outline-none focus:border-brand font-sans"
          />
          <div className="flex items-center gap-1.5">
            <Button variant="primary" size="field" type="submit" disabled={!draft.trim()}>
              {strings.keySave}
            </Button>
            <Button variant="ghost" size="field" onClick={handleClearKey} disabled={!apiKey && !draft}>
              {strings.keyClear}
            </Button>
          </div>
        </form>

        {error && <div className="text-ui text-measure-coral">{error}</div>}

        <div className="text-ui text-ink-muted">{strings.keyRisk}</div>

        <a
          href={API_KEY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-ui text-brand hover:underline w-fit"
        >
          {strings.keyLink}
        </a>
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-2.5 font-sans h-full box-border">
      <form onSubmit={handleSearchSubmit} className="flex items-center gap-1.5 flex-none">
        <div className="relative flex-1 flex items-center">
          <SearchGlyph size={13} className="absolute left-2.5 text-ink-muted pointer-events-none" />
          <input
            type="text"
            name="pixabay-search"
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
            className="w-full h-[25px] pl-7 pr-2.5 bg-inset text-ink placeholder:text-ink-muted text-ui rounded-ctl border border-rule focus:outline-none focus:border-brand font-sans"
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
                      className="absolute top-1 right-1 px-1 py-px rounded-sm border border-rule-strong bg-panel text-tag text-ink-muted pointer-events-none select-none"
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

      <div className="flex items-center justify-between flex-none">
        <span className="text-micro text-ink-muted">PIXABAY</span>
        <Button variant="ghost" size="text" onClick={() => setShowSettings(true)}>
          {strings.keySettings}
        </Button>
      </div>
    </div>
  );
}
