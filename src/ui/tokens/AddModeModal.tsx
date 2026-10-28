import { useState, useRef, useEffect } from "preact/hooks";
import { X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { TEXT_FIELD_CLASS } from "../ScrubInput";
import { setPickerOpen } from "../hooks/picker-focus";

interface AddModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (name: string) => void;
}

export function AddModeModal({ isOpen, onClose, onAdd }: AddModeModalProps) {
  if (!isOpen) return null;

  const [modeName, setModeName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPickerOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => setPickerOpen(false);
  }, []);

  const handleConfirm = () => {
    const clean = modeName.trim();
    if (!clean) return;
    onAdd(clean);
    setModeName("");
    onClose();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
    if (e.key === "Enter") handleConfirm();
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("tokens.addModeTitle")}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-panel border border-rule-strong rounded-panel shadow-modal p-4 w-full max-w-sm flex flex-col gap-3.5 text-ink animate-pop-in">
        <div className="flex items-center justify-between">
          <span className="text-ui font-medium text-ink">{t("tokens.addModeTitle")}</span>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-5 h-5 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised transition-colors"
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <input
            ref={inputRef}
            name="mode-name"
            value={modeName}
            onInput={(e) => setModeName((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            placeholder={t("tokens.modeNamePlaceholder")}
            className={TEXT_FIELD_CLASS}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1 font-sans">
          <Button variant="ghost" size="field" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="field"
            type="button"
            onClick={handleConfirm}
            disabled={!modeName.trim()}
          >
            {t("common.add")}
          </Button>
        </div>
      </div>
    </div>
  );
}
