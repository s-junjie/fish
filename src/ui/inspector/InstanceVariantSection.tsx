import { t } from "../../i18n";
import { Select } from "../Select";
import { ROW_SPREAD_GAP_CLASS } from "../row-style";

/**
 * An instance's variant properties — the whole of what it can be configured with.
 *
 * It was one list of two kinds, because a master could declare named text /
 * boolean / instance-swap properties alongside its variant axes. Those are gone:
 * each one was sugar over a layer override that already worked (`content`,
 * `visible`, `componentId`), and having two channels meant two rules for "what
 * does this instance own" and one word — "property" — meaning both an axis and a
 * binding. So an instance now has exactly one configuration surface, and this is
 * it. Everything else it can differ by is an override on a layer of its master,
 * edited by editing that layer.
 */
export interface VariantPropertyRow {
  /** The axis name, as the set declares it. */
  property: string;
  /** What this instance is set to. */
  value: string;
  /** Every value the set declares, including ones no variant fills. */
  options: string[];
}

export function InstanceVariantSection({
  variantRows,
  onSetVariant
}: {
  variantRows: VariantPropertyRow[];
  onSetVariant: (property: string, value: string) => void;
}) {
  if (variantRows.length === 0) return null;

  return (
    <div className="space-y-1.5 pt-1" data-instance-variant-properties="true">
      {variantRows.map((row) => (
        <div
          key={row.property}
          className={ROW_SPREAD_GAP_CLASS}
          data-instance-variant={row.property}
        >
          <span className="text-meta text-ink-dim w-24 truncate" title={row.property}>
            {row.property}
          </span>
          <div className="flex-1 min-w-0">
            <Select
              value={row.value}
              onChange={(v) => onSetVariant(row.property, v)}
              className="w-full"
            >
              {/* Every value the set declares, including ones no variant fills —
                  picking one is how you find out the matrix has a hole in it, and
                  `setVariant` says so when the combination is not there. */}
              {row.options.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
        </div>
      ))}
    </div>
  );
}