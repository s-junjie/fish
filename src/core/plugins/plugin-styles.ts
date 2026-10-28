const STYLE_ATTRIBUTE = "data-fish-plugin-styles";
const injected = new Set<string>();

/**
 * A plugin's CSS belongs to the plugin's bytes, not to the shell's Tailwind
 * build. Injection is keyed by the stylesheet text, so two panels that ship the
 * same CSS produce one `<style>` element.
 */
export function injectPluginStyles(css: string, doc?: Document): void {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  if (!target?.head || !css.trim() || injected.has(css)) return;

  const style = target.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = css;
  target.head.appendChild(style);
  injected.add(css);
}
