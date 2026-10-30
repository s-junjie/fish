/**
 * One `SKILL.md` source, two renderings.
 *
 * The archive copy travels with `tools/` and `references/` beside it, so it
 * names its siblings relatively. The hosted copy is what a user @-mentions: it
 * has no siblings, so it must carry absolute links and the archive's digest.
 * Both are rendered from `agent-kit/SKILL.md` so the prose cannot fork, and a
 * placeholder that survives rendering is an error rather than a shipped
 * `{{TOKEN}}`.
 */
import { STABLE_KIT, STABLE_SKILL, skillRefPath } from "./release-layout.mjs";

const TOKEN = /\{\{([A-Z0-9_]+)\}\}/g;

/** A reference the archive already carries; the page publishes the same bytes. */
export const SKILL_REFERENCES = ["workflow.md", "dsl.md", "assets.md"];

function trimOrigin(origin) {
  return String(origin).replace(/\/+$/, "");
}

function checksumBlock(sha256) {
  return `printf '%s  fish-agent-kit.zip\\n' '${sha256}' | shasum -a 256 -c -`;
}

function onlineReferences(origin, version) {
  const links = SKILL_REFERENCES.map((name) => `- [references/${name}](${trimOrigin(origin)}/${skillRefPath(version, name)})`);
  return ["Read this without a shell? The same files are published beside this page:", "", ...links].join("\n");
}

export function skillVariables({ origin, version, docVersion, kitFile, kitUrl, kitSha256 = "", hosted = false }) {
  if (hosted && !kitSha256) throw new Error("hosted SKILL.md cannot be rendered without the archive digest");
  // The skill has no version of its own: it is published under the app version
  // and describes one document dialect. Both are read from their single source
  // here rather than typed into the prose, so a stale number cannot ship.
  if (!version) throw new Error("SKILL.md cannot be rendered without an app version");
  if (!docVersion) throw new Error("SKILL.md cannot be rendered without a document dialect");
  return {
    SKILL_VERSION: version,
    DOC_VERSION: docVersion,
    KIT_URL: kitUrl || `${trimOrigin(origin)}/${kitFile}`,
    KIT_STABLE_URL: `${trimOrigin(origin)}/${STABLE_KIT}`,
    SKILL_PAGE_URL: `${trimOrigin(origin)}/${STABLE_SKILL}`,
    // The archive cannot contain its own digest: it is packed after this text.
    // The hosted copy can, because it is written after packing.
    KIT_CHECKSUM_BLOCK: kitSha256
      ? checksumBlock(kitSha256)
      : "# compare with the release's sha256sums.txt before unpacking: shasum -a 256 fish-agent-kit.zip",
    SKILL_REFERENCES_ONLINE: hosted ? onlineReferences(origin, version) : ""
  };
}

export function renderSkill(source, values) {
  const rendered = source.replace(TOKEN, (match, key) => {
    if (values[key] === undefined) throw new Error(`SKILL.md placeholder ${match} has no value`);
    return values[key];
  });
  const leftover = rendered.match(TOKEN);
  if (leftover) throw new Error(`SKILL.md still carries ${leftover.join(", ")}`);
  return rendered;
}
