/**
 * Headless poster snapshot capture and runtime helper injection for HTML embeds.
 *
 * Local documents (srcdoc) are sandboxed with opaque origins, so direct access
 * across the frame boundary is blocked. Snapshot capture communicates via
 * postMessage with an injected listener that grabs a canvas render once the
 * document has settled.
 *
 * There is one moment to capture and it is the frame's own load: an embed is
 * mounted exactly while its layer is selected (see `SvgHtmlEmbedNode`) and it
 * cannot be interacted with outside present mode, so nothing the user does
 * afterwards can change what it draws. The settle capture is therefore the
 * poster, and no "capture on the way out" request is needed.
 */

/**
 * The injected helper, carrying the id of the element it was injected into.
 *
 * The id is what lets the host listener bind a reply to an embed. The headless
 * import path injects without one and its messages carry an empty id, which the
 * listener ignores — that capture is resolved by `captureHeadlessSnapshot`
 * itself, not through the document.
 */
function snapshotHelperScript(elementId: string): string {
  return `
<script data-fish-helper="snapshot">
(function() {
  if (window.__fish_snap__) return;
  window.__fish_snap__ = true;
  var EID = ${JSON.stringify(elementId ?? "")};
  function grabCanvas() {
    try {
      var cs = document.querySelectorAll("canvas");
      var best = null;
      var max = 0;
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        var a = (c.width || 0) * (c.height || 0);
        if (a > max) { max = a; best = c; }
      }
      if (best) {
        return best.toDataURL("image/webp", 0.8) || best.toDataURL("image/png");
      }
    } catch(e) {}
    return null;
  }
  function onSettle() {
    requestAnimationFrame(function() {
      setTimeout(function() {
        var shot = grabCanvas();
        if (!shot) return;
        window.parent.postMessage({ type: "fish:snapshot-ready", id: EID, dataUrl: shot }, "*");
      }, 60);
    });
  }
  if (document.readyState === "complete") {
    onSettle();
  } else {
    window.addEventListener("load", onSettle);
  }
})();
</script>
`.trim();
}

/**
 * Injects the snapshot helper into a srcdoc document string at runtime.
 * Stored DSL is never modified; this runs only when handing markup to the iframe.
 */
export function injectSnapshotHelper(srcdoc: string, elementId = ""): string {
  if (!srcdoc || srcdoc.includes('data-fish-helper="snapshot"')) return srcdoc;
  const script = snapshotHelperScript(elementId);
  const idx = srcdoc.lastIndexOf("</body>");
  if (idx !== -1) {
    return srcdoc.slice(0, idx) + script + srcdoc.slice(idx);
  }
  return srcdoc + script;
}

/**
 * Headless offscreen render to extract an initial raster poster for local html documents.
 * Times out gracefully and returns null in Node/non-browser test runs.
 */
export function captureHeadlessSnapshot(
  srcdoc: string,
  width: number,
  height: number,
  timeoutMs = 250
): Promise<string | null> {
  if (typeof window === "undefined" || typeof document === "undefined" || !srcdoc.trim()) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.top = "-9999px";
    iframe.style.left = "-9999px";
    iframe.style.width = `${Math.max(10, width)}px`;
    iframe.style.height = `${Math.max(10, height)}px`;
    iframe.style.visibility = "hidden";
    iframe.style.border = "none";
    iframe.style.pointerEvents = "none";
    iframe.sandbox = "allow-scripts";

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    };

    const onMessage = (e: MessageEvent) => {
      if (settled) return;
      if (e.data && e.data.type === "fish:snapshot-ready") {
        if (typeof e.data.dataUrl === "string" && e.data.dataUrl.startsWith("data:image/")) {
          settled = true;
          cleanup();
          resolve(e.data.dataUrl);
        }
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
    iframe.srcdoc = injectSnapshotHelper(srcdoc);
  });
}
