import { useEffect, useRef, useState } from "preact/hooks";
import { parseColorAlpha, isValidHex } from "../core/geometry/color-utils";

interface HexInputProps {
  value: string;
  onChange: (hex6: string, alphaPct?: number) => void;
  onCommit?: () => void;
  prefixHash?: boolean;
  placeholder?: string;
  className?: string;
  "data-hex-input"?: string;
}

export function HexInput({
  value,
  onChange,
  onCommit,
  prefixHash = true,
  placeholder,
  className = "",
  "data-hex-input": dataHexInput
}: HexInputProps) {
  const focusedRef = useRef(false);

  const format = (raw: string) => {
    if (!raw || !raw.trim()) return "";
    const parsed = parseColorAlpha(raw);
    const hex = parsed.hex6.toUpperCase();
    return prefixHash ? hex : hex.replace("#", "");
  };

  const formattedPlaceholder = placeholder
    ? prefixHash
      ? (placeholder.startsWith("#") ? placeholder : `#${placeholder}`)
      : placeholder.replace("#", "")
    : undefined;

  const [draft, setDraft] = useState(() => format(value));

  useEffect(() => {
    setDraft(format(value));
  }, [value, prefixHash]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft("");
      onChange("");
      onCommit?.();
      return;
    }
    if (!isValidHex(trimmed)) {
      setDraft(format(value));
      return;
    }
    const cleanWithHash = trimmed.startsWith("#") ? trimmed : "#" + trimmed;
    const nextParsed = parseColorAlpha(cleanWithHash);
    const hasExplicitAlpha = cleanWithHash.length === 5 || cleanWithHash.length === 9;
    setDraft(format(nextParsed.hex6));
    onChange(nextParsed.hex6, hasExplicitAlpha ? nextParsed.alphaPct : undefined);
    onCommit?.();
  };

  return (
    <input
      type="text"
      data-hex-input={dataHexInput}
      name={dataHexInput || "hex-color"}
      value={draft}
      placeholder={formattedPlaceholder}
      onFocus={(e) => {
        (e.currentTarget as HTMLInputElement).select();
      }}
      onClick={(e) => {
        if (!focusedRef.current) {
          (e.currentTarget as HTMLInputElement).select();
          focusedRef.current = true;
        }
      }}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.isComposing || (e as any).keyCode === 229) return;
        if (e.key === "Enter") {
          commit();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(format(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      spellcheck={false}
      className={className}
    />
  );
}
