import { createId } from "../id";
import { DEFAULT_STROKE_COLOR } from "../dsl/defaults";
import type { PathElement } from "../dsl/types";
import { fetchCollections, fetchIconBodies, fetchIconNames, resolveAlias, type IconifyCollection } from "../assets/iconify";
import { parseIconBody } from "../assets/svg-body";
import { ICON_PAGE_SIZE, type AssetCredit, type AssetProvider, type AssetInsertResult, type AssetSearchResult } from "./types";

/**
 * A provider backed by one Iconify set. Everything the two shipped sets have in
 * common lives here; a set is a prefix and a name, and that is the whole
 * difference between them.
 *
 * The panel needs a name before it has geometry, so the two are fetched
 * separately: names come from a list that is cached for a week, bodies for the
 * window actually on screen. A search over five thousand names is therefore a
 * local scan plus one hundred-and-fifty-name request, not five thousand
 * requests, and a failure is text in the panel rather than an empty grid.
 */

const titleCase = (slug: string) =>
  slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** `x` is a letter; every other glyph in these sets is a hyphenated phrase. */
const displayName = (name: string) => (name === "x" ? "X" : titleCase(name));

/**
 * Substring matches ranked so the name the user typed comes first. Iconify
 * names are one long hyphenated phrase, so a plain alphabetical scan lists
 * `arrow-left` above `chevron-arrow-left` and puts an exact hit in the middle
 * of the grid, which reads as a broken search.
 */
function rank(name: string, query: string): number {
  if (!query) return 0;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split("-")[0] === query) return 2;
  if (name.split("-").includes(query)) return 3;
  return 4;
}

const creditOf = (set: IconifyCollection | undefined): AssetCredit | undefined => {
  if (!set) return undefined;
  const licence = set.license?.spdx || set.license?.title;
  const url = set.homepage || set.author?.url || set.license?.url;
  if (!licence) return undefined;
  return url ? { name: `${set.name} · ${licence}`, url } : { name: `${set.name} · ${licence}`, url: "" };
};

export interface IconifyProviderOptions {
  prefix: string;
  /** i18n key for the panel's label. */
  nameKey: string;
  /** Human name, used only as the fallback when no dictionary is loaded. */
  name: string;
}

export function createIconifyProvider(options: IconifyProviderOptions): AssetProvider {
  const { prefix } = options;

  const setMeta = async (): Promise<IconifyCollection | undefined> => {
    try {
      const all = await fetchCollections([prefix]);
      return all.find((c) => c.prefix === prefix);
    } catch {
      return undefined;
    }
  };

  return {
    id: prefix,
    name: options.name,
    nameKey: options.nameKey,
    kind: "icon",

    /**
     * Not `remote`: the panel skips a remote source on an empty query, which
     * would hide the grid the tab exists to show. This one fetch is a name list
     * the browser keeps for a week.
     *
     * A window is `[offset, offset + limit)` of the *ranked* list, not of the
     * raw names: page two has to continue the order the user is looking at, and
     * taking the offset before the sort would page through the alphabet and put
     * a search's best hits on a later screen. Bodies are fetched only for the
     * names inside this window, so a second page costs one request and the first
     * page is never re-downloaded.
     */
    async search(query: string, limit: number = ICON_PAGE_SIZE, offset = 0): Promise<AssetSearchResult[]> {
      const q = query.trim().toLowerCase();
      let names: string[];
      try {
        names = await fetchIconNames(prefix);
      } catch {
        return [];
      }

      // A copy: with no query this sorts the array the week-long cache holds,
      // and a cached list that other callers read must not move under them.
      const matched = (q ? names.filter((n) => n.includes(q)) : [...names])
        .sort((a, b) => rank(a, q) - rank(b, q) || a.localeCompare(b))
        .slice(Math.max(0, offset), offset + limit);
      if (matched.length === 0) return [];

      let batch;
      try {
        batch = await fetchIconBodies(prefix, matched);
      } catch {
        return [];
      }

      const credit = creditOf(await setMeta());
      const results: AssetSearchResult[] = [];
      for (const iconName of matched) {
        const icon = resolveAlias(iconName, batch);
        if (!icon) continue;
        const g = parseIconBody(icon.body);
        // A body the converter does not understand is left out rather than
        // inserted as a blank box: a missing icon is obvious, a silent hole in
        // a design is not.
        if (!g) continue;
        results.push({
          id: `${prefix}:${iconName}`,
          name: displayName(iconName),
          iconPaths: [g.d],
          iconRender: {
            mode: g.mode,
            fillRule: g.fillRule,
            strokeWidth: g.strokeWidth,
            cap: g.cap,
            join: g.join
          },
          credit
        });
      }
      return results;
    },

    insert(result, target): AssetInsertResult {
      const d = (result.iconPaths || []).join("");
      const render = result.iconRender;
      const fillMode = render?.mode === "fill";
      const element: PathElement = {
        id: createId("path"),
        type: "path",
        name: result.name,
        x: Math.round(target.x),
        y: Math.round(target.y),
        // The set's viewBox, not the glyph's ink: a grid of icons has to line
        // up, and the clickable area follows the path data rather than the box.
        width: 24,
        height: 24,
        d,
        ...(fillMode
          ? { fills: [{ type: "solid" as const, color: DEFAULT_STROKE_COLOR }] }
          : {
              strokes: [
                {
                  color: DEFAULT_STROKE_COLOR,
                  width: render?.strokeWidth ?? 2,
                  cap: render?.cap ?? "round",
                  join: render?.join ?? "round"
                }
              ]
            }),
        ...(render?.fillRule && render.fillRule !== "nonzero" ? { fillRule: render.fillRule } : {})
      };
      return { element };
    }
  };
}
