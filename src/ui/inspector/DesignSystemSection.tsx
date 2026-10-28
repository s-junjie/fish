import { useState } from "preact/hooks";
import { SwatchBook } from "lucide-react";
import type { DesignDocument } from "../../core/dsl/types";
import { TokensTablePanel } from "../tokens/TokensTablePanel";
import { t } from "../../i18n";
import { Button } from "../Button";
import { SegmentedControl } from "../SegmentedControl";
import { ColorTokenList } from "./ColorTokenList";
import { NumberTokenList } from "./NumberTokenList";
import { LocalStylesSection } from "./LocalStylesSection";

type DesignSystemTab = "tokens" | "styles";

interface DesignSystemSectionProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
}

/**
 * Document-level design system: tokens and styles.
 */
export function DesignSystemSection({ doc, docRef, commitSnapshot }: DesignSystemSectionProps) {
  const [tab, setTab] = useState<DesignSystemTab>("tokens");
  const [isTableOpen, setIsTableOpen] = useState(false);

  return (
    <div className="flex-1 flex flex-col min-h-0 select-none overflow-hidden" data-design-system-section="1">
      {/* Pinned Tab Header: does not participate in scroll */}
      <div className="px-3 pt-2 pb-2 border-b border-rule shrink-0 bg-panel flex items-center gap-1.5">
        <SegmentedControl
          items={[
            { value: "tokens", label: t("tokens.tabTokens"), grow: true },
            { value: "styles", label: t("tokens.tabStyles"), grow: true }
          ]}
          value={tab}
          onChange={setTab}
          className="flex-1 min-w-0"
          rowProps={{ "data-design-system-tabs": "1" }}
        />
        <Button
          size="iconLg"
          type="button"
          onClick={() => setIsTableOpen((prev) => !prev)}
          title={t("tokens.openTablePanel")}
          aria-label={t("tokens.openTablePanel")}
          className={`flex items-center justify-center shrink-0 rounded-swatch ${isTableOpen ? "text-brand bg-raised hover:text-brand" : "text-ink-muted hover:text-ink"
            }`}
        >
          <SwatchBook size={14} />
        </Button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4 min-h-0">
        {tab === "tokens" ? (
          <div className="space-y-4">
            <ColorTokenList doc={doc} docRef={docRef} commitSnapshot={commitSnapshot} />
            <NumberTokenList doc={doc} docRef={docRef} commitSnapshot={commitSnapshot} />
          </div>
        ) : (
          <LocalStylesSection
            doc={doc}
            docRef={docRef}
            commitSnapshot={commitSnapshot}
            styleTypes={["paint", "stroke", "text", "effect"]}
            createStyleTypes={["paint", "stroke", "text", "effect"]}
            showStylePreview={false}
          />
        )}
      </div>

      <TokensTablePanel
        doc={doc}
        docRef={docRef}
        commitSnapshot={commitSnapshot}
        isOpen={isTableOpen}
        onClose={() => setIsTableOpen(false)}
      />
    </div>
  );
}
