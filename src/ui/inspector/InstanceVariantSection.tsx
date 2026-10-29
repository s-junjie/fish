import { t } from "../../i18n";
import { Select } from "../Select";
import { Switch } from "../Switch";
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
  /** The subset of `options` no member fills — a hole in the matrix. */
  holes?: string[];
}

/**
 * The two values of a boolean axis, in the spellings design systems actually use.
 *
 * A row like `Disabled: True / False` is a switch, not a two-item menu: opening a
 * dropdown to pick the other of two values is two clicks for one bit. Matched
 * case-insensitively because the same set is written `True` and `true`, and
 * `On/Off` and `Yes/No` are the same convention under another word.
 */
const BOOLEAN_PAIRS: ReadonlyArray<readonly [truthy: string, falsy: string]> = [
  ["true", "false"],
  ["yes", "no"],
  ["on", "off"]
];

export function parseBooleanPair(options: string[]): { truthy: string; falsy: string } | null {
  if (options.length !== 2) return null;
  const byCase = new Map(options.map((option) => [option.toLowerCase(), option]));
  for (const [truthy, falsy] of BOOLEAN_PAIRS) {
    const on = byCase.get(truthy);
    const off = byCase.get(falsy);
    if (on !== undefined && off !== undefined) return { truthy: on, falsy: off };
  }
  return null;
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
      {variantRows.map((row) => {
        const pair = parseBooleanPair(row.options);
        const holes = row.holes ?? [];
        return (
          <div
            key={row.property}
            className={ROW_SPREAD_GAP_CLASS}
            data-instance-variant={row.property}
          >
            <span className="text-meta text-ink-dim w-24 truncate" title={row.property}>
              {row.property}
            </span>
            <div className="flex-1 min-w-0 flex justify-end">
              {pair ? (
                <Switch
                  checked={row.value === pair.truthy}
                  onChange={(on) => onSetVariant(row.property, on ? pair.truthy : pair.falsy)}
                  title={row.property}
                  data-variant-switch={row.property}
                />
              ) : (
                <Select
                  value={row.value}
                  onChange={(v) => onSetVariant(row.property, v)}
                  className="w-full"
                >
                  {/* Every value the set declares, including ones no variant fills.
                      The empty cells are marked, because a value that changes
                      nothing when picked has to say so before it is picked. */}
                  {row.options.map((v) => (
                    <option key={v} value={v}>
                      {holes.includes(v) ? t("component.variantOptionMissing", { value: v }) : v}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
