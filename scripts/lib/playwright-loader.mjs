// Playwright is a peer of the verification scripts, not a bundled dependency: the
// library plus one browser is ~215 MB, and an agent that only wants to read a
// document in a browser tab should not have to pay that to learn it.
//
// A static `import` cannot be guarded — the module-resolution failure happens
// before any of the script's own code runs, so the user sees a bare
// ERR_MODULE_NOT_FOUND from Node's internals rather than the two commands that
// would fix it. Hence the dynamic import.
export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    console.error(
      `\nPlaywright is not installed here.\n\n` +
        `  npm install                                # the library (~18 MB)\n` +
        `  npx playwright install --only-shell chromium  # the headless shell (~195 MB)\n\n` +
        `The second command is separate because \`playwright\` ships no postinstall.\n` +
        `Already have Playwright browsers on this machine? They share one cache, so\n` +
        `skip it. Prefer not to install anything? Open the document with ?view=canvas\n` +
        `and use window.__fish directly — validate() / measure() / exportCanvasPng()\n` +
        `are the same loop.\n`
    );
    process.exit(2);
  }
}
