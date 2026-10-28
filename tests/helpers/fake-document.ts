// The document surface `capturePristine` and the write path touch, without a DOM.
//
// The clone is the point, not a detail: `capturePristine` serialises a filtered
// clone so the shell's injected `<style>` and `<script>` never reach a saved file.
// A fake carrying only `outerHTML` would let that regress silently, so every stub
// in this file hands back a documentElement that can be cloned and swept.

/** A documentElement whose clone can be swept, mimicking a real filtered clone. */
export function fakeDocumentElement(outerHTML: string, transientCount = 0) {
  let live = outerHTML;
  return {
    get outerHTML() {
      return live;
    },
    set outerHTML(value: string) {
      live = value;
    },
    cloneNode: () => ({
      // what the clone serialises: the file's own markup, minus transient nodes
      outerHTML: transientCount ? outerHTML.replace("<body>", `<body><!--${transientCount} transient-->`) : outerHTML,
      querySelectorAll: () =>
        Array.from({ length: transientCount }, () => ({
          remove() {}
        }))
    })
  };
}

/** Installs `globalThis.document` for one test and returns a restore function. */
export function stubDocument(extra: Record<string, unknown> = {}, transientCount = 0, outerHTML = "<html></html>") {
  const previous = (globalThis as any).document;
  (globalThis as any).document = { documentElement: fakeDocumentElement(outerHTML, transientCount), ...extra };
  return () => {
    (globalThis as any).document = previous;
  };
}