import { useCallback, useMemo } from "preact/hooks";
import { assetUsageCounts, unusedAssetIds } from "../../core/dsl/asset-usage";
import type { DesignDocument } from "../../core/dsl/types";
import { t } from "../../i18n";

interface AssetUsageOptions {
  doc: DesignDocument;
  /** Read at click time: the panel's numbers are rendered, the removal is not. */
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  showHint: (message: string) => void;
}

/**
 * How many places point at each asset, plus the one action that reads it.
 *
 * The scan runs twice on purpose — once to render the counts, once at click time
 * against `docRef.current`. A count memoized on `doc` is at most one commit old,
 * and deleting what that stale count named would be the one mistake here that
 * loses bytes the user cannot name.
 */
export function useAssetUsage({ doc, docRef, commitSnapshot, showHint }: AssetUsageOptions) {
  const assetUsage = useMemo(() => assetUsageCounts(doc), [doc]);

  const cleanUnusedAssets = useCallback(() => {
    const current = docRef.current;
    const unused = new Set(unusedAssetIds(current));
    if (unused.size === 0) {
      showHint(t("assets.noUnused"));
      return;
    }
    commitSnapshot({
      ...current,
      assets: (current.assets ?? []).filter((asset) => !unused.has(asset.id))
    });
    showHint(t("assets.removedUnused", { count: unused.size }));
  }, [docRef, commitSnapshot, showHint]);

  return { assetUsage, cleanUnusedAssets };
}
