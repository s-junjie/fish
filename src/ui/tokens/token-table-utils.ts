/**
 * Utility functions for grouping and formatting tokens for the Tokens Table Overview.
 */

export interface TokenGroupItem<T> {
  token: T;
  displayName: string;
  fullName: string;
}

export interface TokenGroup<T> {
  groupName: string;
  items: TokenGroupItem<T>[];
}

export function groupTokensByName<T extends { name: string }>(
  tokens: T[],
  searchQuery = ""
): TokenGroup<T>[] {
  const query = searchQuery.trim().toLowerCase();
  const filtered = query
    ? tokens.filter((t) => t.name.toLowerCase().includes(query))
    : tokens;

  const groupsMap = new Map<string, TokenGroupItem<T>[]>();

  for (const token of filtered) {
    const rawName = token.name.trim();
    const slashIdx = rawName.lastIndexOf("/");
    const groupName = slashIdx > 0 ? rawName.slice(0, slashIdx).trim() : "";
    const displayName = slashIdx > 0 ? rawName.slice(slashIdx + 1).trim() : rawName;

    if (!groupsMap.has(groupName)) {
      groupsMap.set(groupName, []);
    }
    groupsMap.get(groupName)!.push({
      token,
      displayName,
      fullName: rawName
    });
  }

  const sortedKeys = Array.from(groupsMap.keys()).sort((a, b) => {
    if (a === "" && b !== "") return 1;
    if (b === "" && a !== "") return -1;
    return a.localeCompare(b);
  });

  return sortedKeys.map((groupName) => ({
    groupName,
    items: groupsMap.get(groupName)!.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }));
}

/**
 * Generate a sequential, human-friendly unique token name:
 * e.g. `color 1`, `color 2`, `color 3`... or `group/color 1`...
 */
export function generateUniqueTokenName(
  existingTokens: { name: string }[],
  baseName: string,
  groupPrefix?: string
): string {
  const prefix = groupPrefix ? `${groupPrefix}/` : "";
  const existingSet = new Set(
    existingTokens.map((t) => t.name.trim().toLowerCase())
  );

  let n = 1;
  while (true) {
    const candidate = `${prefix}${baseName} ${n}`;
    if (!existingSet.has(candidate.toLowerCase())) {
      return candidate;
    }
    n++;
  }
}

