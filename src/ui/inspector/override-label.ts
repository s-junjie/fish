import { t } from "../../i18n";

/**
 * The tag on one thing an instance has changed — its own fill, its box, a child's
 * content. The key names the field; the dictionary supplies the noun, and a field
 * with no entry falls back to its own name rather than to a missing-key marker.
 *
 * One implementation because two panels draw the same tag: the instance's own
 * fields and the fields of a layer inside it.
 */
export function overrideLabel(field: string): string {
  const key = `component.overrideLabel.${field}`;
  const label = t(key);
  return label === key ? field : label;
}
