import type { AssetRef } from "../../core/dsl/types";
import type { ComponentEntry, ComponentSet } from "../../core/interactions/component-inventory";

export type FilteredComponentItem =
  | { kind: "set"; set: ComponentSet; entry: ComponentEntry }
  | { kind: "single"; entry: ComponentEntry };

function tokenizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesTokens(haystack: string, tokens: string[]): boolean {
  const lower = haystack.toLowerCase();
  return tokens.every((tok) => lower.includes(tok));
}

function variantText(props: Record<string, string> | undefined): string {
  if (!props) return "";
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v} ${v}`)
    .join(" ");
}

export function filterAssets(assets: AssetRef[], query: string): AssetRef[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return assets;
  return assets.filter((a) => matchesTokens(a.name, tokens));
}

/**
 * Filter grouped component sets and standalone components.
 *
 * A set matches either on its own name (keeping all variants so the author can
 * expand and pick any of them) or on individual member names / variant values.
 * Filtering members BEFORE checking `set.name` previously emptied `members` and
 * dropped the set via `defaultMember` whenever members only carried `Prop=Val`.
 */
export function filterComponentItems(
  sets: ComponentSet[],
  singles: ComponentEntry[],
  query: string
): FilteredComponentItem[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return [
      ...sets.map((s) => ({ kind: "set" as const, set: s, entry: s.defaultMember })),
      ...singles.map((e) => ({ kind: "single" as const, entry: e }))
    ];
  }

  const keptSets = sets.flatMap((s) => {
    if (matchesTokens(s.name, tokens)) return [s];
    const matchedMembers = s.members.filter((m) =>
      matchesTokens(`${s.name} ${m.name} ${variantText(m.variantProperties)}`, tokens)
    );
    if (matchedMembers.length === 0) return [];
    const defaultMember = matchedMembers.find((m) => m.id === s.defaultMember.id) || matchedMembers[0];
    return [{ ...s, members: matchedMembers, defaultMember }];
  });

  const keptSingles = singles.filter((e) =>
    matchesTokens(`${e.name} ${variantText(e.variantProperties)}`, tokens)
  );

  return [
    ...keptSets.map((s) => ({ kind: "set" as const, set: s, entry: s.defaultMember })),
    ...keptSingles.map((e) => ({ kind: "single" as const, entry: e }))
  ];
}
