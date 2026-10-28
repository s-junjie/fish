import { useMemo, useState } from "preact/hooks";
import { DesignElement } from "../../core/dsl/types";
import { normalizeLink } from "../../core/dsl/link";
import { t } from "../../i18n";
import { MIXED_LABEL } from "./mixed";
import { X } from "lucide-react";
import { Section } from "./SectionHeader";
import { Button } from "../Button";
import { ROW_DENSE_CLASS } from "../row-style";

interface LinkSectionProps {
  /** The whole selection: the URL is one value or it is none. */
  elements: DesignElement[];
  primarySelected: DesignElement | null;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
}

/**
 * The URL a layer opens, and the one thing you do with one: remove it.
 *
 * The editor deliberately does not open links on a plain click — that click
 * selects — so the URL is only ever tried from a viewing surface (Present, the
 * embedded canvas view, an exported SVG). There is no "open here" button
 * because there is nothing here to open it into.
 */
export function LinkSection({ elements, primarySelected, onMutate }: LinkSectionProps) {
  const id = primarySelected?.id ?? null;
  // Tagged with the layer, because a section is not remounted when the selection
  // moves: an un-tagged flag would carry one layer's bad URL onto the next one.
  const [invalidId, setInvalidId] = useState<string | null>(null);
  if (!primarySelected) return null;

  const invalid = invalidId !== null && invalidId === id;
  const link = primarySelected.link ?? "";
  const linksMixed = useMemo(
    () => elements.length > 1 && elements.some((el) => (el.link ?? "") !== link),
    [elements, link]
  );

  const write = (next: string | undefined) => {
    if (next === (primarySelected.link ?? undefined)) return;
    onMutate((el) => {
      const updated = { ...el };
      if (next) updated.link = next;
      else delete updated.link;
      return updated;
    }, true);
  };

  const commit = (raw: string) => {
    // Cleared is a legitimate edit, not a malformed one.
    if (!raw.trim()) {
      setInvalidId(null);
      write(undefined);
      return;
    }
    const next = normalizeLink(raw);
    if (!next) {
      // Held in the field rather than reverted: the text the user typed is the
      // thing to correct, and wiping it is how a typo becomes a lost link.
      setInvalidId(id);
      return;
    }
    setInvalidId(null);
    write(next);
  };

  return (
    <Section id="link" title={t("link.title")}>
      <div className={ROW_DENSE_CLASS}>
        <input
          // Re-keyed on the stored value so an undo, or a click on another layer,
          // replaces the text instead of leaving the previous URL in the field.
          key={`${primarySelected.id}-${link}`}
          name="link-url"
          data-link-input="true"
          data-mixed={linksMixed ? "true" : undefined}
          defaultValue={linksMixed ? "" : link}
          // Three layers, three URLs, is not "a link with a mixed value" to show
          // one of them in. The field starts empty and commits whatever is typed
          // to all of them.
          placeholder={linksMixed ? MIXED_LABEL : t("link.placeholder")}
          spellcheck={false}
          onBlur={(e) => commit((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          /* The same well as a `ScrubInput`: 25px, 3px radius, `inset` fill, no
             border of its own. A bordered 12px box beside a field read as a
             different kind of control for the same job. The invalid state keeps
             its ring — that is information, not chrome. */
          className={`flex-1 min-w-0 h-[25px] px-[7px] bg-inset rounded-swatch text-row text-ink placeholder:text-ink-muted focus:outline-none ring-1 ring-inset ${
            invalid ? "ring-measure-coral/70" : "ring-transparent focus:ring-brand"
          }`}
        />
        {link && (
          <Button
            variant="danger"
            size="icon"
            type="button"
            data-link-clear="true"
            title={t("link.clear")}
            aria-label={t("link.clear")}
            onClick={() => write(undefined)}
          >
            <X size={12} />
          </Button>
        )}
      </div>

      {/* Only the refusal speaks. A standing description of what a link does is
          a paragraph the panel repeats on every selection, and the field's own
          red ring already says the URL did not take. */}
      {invalid && (
        <p className="text-ui leading-snug text-measure-coral">{t("link.invalid")}</p>
      )}
    </Section>
  );
}
