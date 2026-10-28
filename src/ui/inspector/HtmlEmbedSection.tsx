import { useState } from "preact/hooks";
import { DesignElement, HtmlEmbedElement } from "../../core/dsl/types";
import { isFrameableUrl } from "../../core/dsl/html-source";
import { Section } from "./SectionHeader";
import { SUB_LABEL_CLASS } from "../label-tier";
import { Button } from "../Button";
import { CheckRow } from "../CheckRow";
import { t } from "../../i18n";
import { Globe, FileCode2, ExternalLink } from "lucide-react";
import { ROW_DENSE_CLASS } from "../row-style";

interface HtmlEmbedSectionProps {
  primarySelected: DesignElement;
  onMutate: (updater: (el: DesignElement) => DesignElement, commitImmediately?: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * An embed's source, and the one switch over how it is drawn.
 *
 * The remaining note is the framing one, and it is shown rather than left
 * implicit because a site that refuses framing paints blank — a failure the
 * author would otherwise read as a bug in the tool.
 */
export function HtmlEmbedSection({ primarySelected, onMutate }: HtmlEmbedSectionProps) {
  const id = primarySelected?.id ?? null;
  // Tagged with the layer, because a section is not remounted when the selection
  // moves: an un-tagged flag would carry one embed's bad URL onto the next one.
  const [invalidId, setInvalidId] = useState<string | null>(null);
  if (primarySelected.type !== "html") return null;

  const el = primarySelected as HtmlEmbedElement;
  const invalid = invalidId !== null && invalidId === id;
  const src = el.src ?? "";
  const isUrl = Boolean(src);
  const inlineBytes = el.srcdoc ? new Blob([el.srcdoc]).size : 0;

  const writeSrc = (next: string) => {
    if (next === src) return;
    onMutate((prev) => {
      const updated = { ...prev } as HtmlEmbedElement;
      if (next) updated.src = next;
      else delete updated.src;
      return updated;
    }, true);
  };

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setInvalidId(null);
      writeSrc("");
      return;
    }
    if (!isFrameableUrl(trimmed)) {
      // Held in the field rather than reverted, for the reason the link field
      // holds a bad URL: the text the user typed is the thing to correct.
      setInvalidId(id);
      return;
    }
    setInvalidId(null);
    writeSrc(trimmed);
  };

  return (
    <Section id="html-embed" title={t("htmlEmbed.title")} data-inspector-section="html">
      <div className="flex items-center justify-between p-1.5 bg-raised/50 rounded-ctl border border-rule">
        <div className="flex items-center gap-1.5 text-ink text-meta font-medium min-w-0">
          {isUrl ? (
            <Globe size={12} className="text-brand shrink-0" />
          ) : (
            <FileCode2 size={12} className="text-brand shrink-0" />
          )}
          <span className="truncate">{el.name || t("htmlEmbed.noSource")}</span>
        </div>
        <span className="text-micro font-mono text-ink-dim shrink-0">
          {isUrl ? t("htmlEmbed.kindUrl") : t("htmlEmbed.kindInline")}
        </span>
      </div>

      {isUrl && (
        <div className={ROW_DENSE_CLASS}>
          <input
            // Re-keyed on the stored value so an undo, or a click on another
            // layer, replaces the text instead of leaving the previous URL in
            // the field.
            key={`${el.id}-${src}`}
            data-html-embed-url="true"
            name="html-embed-url"
            defaultValue={src}
            placeholder={t("toolbar.htmlUrlPlaceholder")}
            spellcheck={false}
            onBlur={(e) => commit((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className={`flex-1 min-w-0 h-[25px] px-[7px] bg-inset rounded-swatch text-row text-ink placeholder:text-ink-muted focus:outline-none ring-1 ring-inset ${
              invalid ? "ring-measure-coral/70" : "ring-transparent focus:ring-brand"
            }`}
          />
          {/* The editor's own click selects the layer, so the framed page is
              never the thing you are pointing at — this is the one way to see
              it at its own size. */}
          <Button
            variant="ghost"
            size="icon"
            type="button"
            data-html-embed-open="true"
            title={t("htmlEmbed.openExternal")}
            aria-label={t("htmlEmbed.openExternal")}
            onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink size={12} />
          </Button>
        </div>
      )}

      {!isUrl && (
        <div className="flex items-center justify-between p-1.5 bg-raised/40 rounded-ctl border border-rule">
          <span className={SUB_LABEL_CLASS}>{t("htmlEmbed.inlineSize")}</span>
          <span className="font-mono text-meta text-ink-dim">{formatBytes(inlineBytes)}</span>
        </div>
      )}

      <div className="pt-0.5 px-0.5">
        <CheckRow
          testId="html-always-live"
          checked={el.alwaysLive === true}
          onChange={(checked) =>
            onMutate((prev) => {
              const next = { ...prev } as HtmlEmbedElement;
              if (checked) next.alwaysLive = true;
              else delete next.alwaysLive;
              return next;
            }, true)
          }
          label={t("htmlEmbed.alwaysLive")}
        />
      </div>

      {invalid && <p className="text-row leading-snug text-measure-coral px-0.5">{t("toolbar.htmlUrlError")}</p>}
      {isUrl && <p className="text-row leading-snug text-ink-muted px-0.5">{t("htmlEmbed.framingNote")}</p>}
    </Section>
  );
}
