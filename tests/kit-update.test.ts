import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkKitUpdate, reinstallCommand } from "../src/core/cli/kit-update";

/**
 * The one question the kit answers over the network, and the rules that keep it
 * from becoming a tax: never on a dev build, never twice a day, never louder than
 * a line the reader can act on, and never a downgrade offered as an update.
 */
const REPO = path.resolve(__dirname, "..");
const ORIGIN = "https://dl.example.test";
const MANIFEST = `${ORIGIN}/stable/manifest.json`;
const INSTALL = `${ORIGIN}/stable/fish-agent-kit.zip`;

function tmpCache(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fish-kit-update-")), "check.json");
}

function envelope(version: string): string {
  return JSON.stringify({ payload: JSON.stringify({ app: "fish", version, url: "u", sha256: "0".repeat(64) }), sig: "s" });
}

/** A fetch that answers with `body`, and counts how many times it was asked. */
function source(body: string) {
  const calls = { count: 0 };
  const fetchImpl = async () => {
    calls.count += 1;
    return { ok: true, status: 200, text: async () => body };
  };
  return { calls, fetchImpl };
}

const base = { manifestUrl: MANIFEST, installUrl: INSTALL, current: "1.0.0" };

describe("a kit that is behind says so, once, with the command to fix it", () => {
  it("reports the newer release and how to take it", async () => {
    const { fetchImpl } = source(envelope("1.0.3"));
    const result = await checkKitUpdate({ ...base, cacheFile: tmpCache(), fetchImpl });
    expect(result.status).toBe("behind");
    if (result.status !== "behind") return;
    expect(result.latest).toBe("1.0.3");
    expect(result.message).toContain("1.0.0");
    expect(result.message).toContain("1.0.3");
    expect(result.message).toContain(`npx skills add "${INSTALL}" --skill fish-design -y`);
  });

  it("stays quiet when the release is the one it is running", async () => {
    const { fetchImpl } = source(envelope("1.0.0"));
    expect((await checkKitUpdate({ ...base, cacheFile: tmpCache(), fetchImpl })).status).toBe("current");
  });

  it("never offers a downgrade as an update", async () => {
    const { fetchImpl } = source(envelope("0.9.9"));
    expect((await checkKitUpdate({ ...base, cacheFile: tmpCache(), fetchImpl })).status).toBe("current");
  });
});

describe("a check that cannot answer is not a verdict", () => {
  it("returns unknown when the origin is unreachable", async () => {
    const fetchImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    expect((await checkKitUpdate({ ...base, cacheFile: tmpCache(), fetchImpl })).status).toBe("unknown");
  });

  it("returns unknown for a payload it cannot read", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ payload: "{oops" })]) {
      const { fetchImpl } = source(body);
      expect((await checkKitUpdate({ ...base, cacheFile: tmpCache(), fetchImpl })).status).toBe("unknown");
    }
  });
});

describe("it costs one request a day, not one per command", () => {
  it("answers from the cache inside the window", async () => {
    const cacheFile = tmpCache();
    const first = source(envelope("1.0.3"));
    let clock = 1_000;
    const now = () => clock;

    await checkKitUpdate({ ...base, cacheFile, fetchImpl: first.fetchImpl, now });
    clock += 60 * 60 * 1000;
    const second = await checkKitUpdate({ ...base, cacheFile, fetchImpl: first.fetchImpl, now });

    expect(second.status).toBe("behind");
    expect(second.status === "behind" && second.fromCache).toBe(true);
    expect(first.calls.count).toBe(1);
  });

  it("asks again once the window has passed, and when told to force", async () => {
    const cacheFile = tmpCache();
    let clock = 1_000;
    const now = () => clock;
    const { calls, fetchImpl } = source(envelope("1.0.0"));

    await checkKitUpdate({ ...base, cacheFile, fetchImpl, now });
    clock += 25 * 60 * 60 * 1000;
    await checkKitUpdate({ ...base, cacheFile, fetchImpl, now });
    expect(calls.count).toBe(2);

    await checkKitUpdate({ ...base, cacheFile, fetchImpl, now, force: true });
    expect(calls.count).toBe(3);
  });

  it("caches the failure, so an offline machine pays the timeout once", async () => {
    const cacheFile = tmpCache();
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw new Error("offline");
    };

    await checkKitUpdate({ ...base, cacheFile, fetchImpl });
    await checkKitUpdate({ ...base, cacheFile, fetchImpl });
    expect(attempts).toBe(1);
  });
});

describe("it stays out of the way where it has nothing to compare", () => {
  it("is off for a local build with no origin", async () => {
    expect(await checkKitUpdate({ manifestUrl: "" })).toEqual({ status: "off", reason: "no-origin" });
  });

  it("is off for a dev build, which is not a release", async () => {
    expect(await checkKitUpdate({ ...base, current: "dev" })).toEqual({ status: "off", reason: "dev-build" });
  });

  it("is off when asked to be", async () => {
    const off = await checkKitUpdate({ ...base, env: { FISH_NO_UPDATE_CHECK: "1" } });
    expect(off).toEqual({ status: "off", reason: "opted-out" });
    // A value of `0` is how a wrapper script says "I did not mean to disable it".
    const { fetchImpl } = source(envelope("1.0.0"));
    expect((await checkKitUpdate({ ...base, env: { FISH_NO_UPDATE_CHECK: "0" }, cacheFile: tmpCache(), fetchImpl })).status).toBe("current");
  });
});

/**
 * The two URLs are build output, not source: drop one `define` and the shipped
 * kit silently reports "there is nothing to check against", which looks exactly
 * like a build that is current. Grade the wiring, not just the function.
 */
describe("the build stamps what the kit needs to check itself", () => {
  const script = fs.readFileSync(path.join(REPO, "scripts/build-fish-agent-kit.mjs"), "utf-8");

  it("defines the app version and both release URLs for the CLI bundle", () => {
    for (const name of ["__FISH_APP_VERSION__", "__FISH_KIT_MANIFEST_URL__", "__FISH_KIT_INSTALL_URL__"]) {
      expect(script).toContain(`${name}: JSON.stringify`);
    }
    expect(script).toContain("STABLE_MANIFEST");
    expect(script).toContain("STABLE_KIT");
  });

  it("takes both from the release layout rather than from a typed path", () => {
    expect(script).toContain('from "./lib/release-layout.mjs"');
  });

  it("names a command an agent can paste unchanged", () => {
    expect(reinstallCommand(INSTALL)).toBe(`npx skills add "${INSTALL}" --skill fish-design -y`);
    expect(reinstallCommand("")).toContain("SKILL.md");
  });
});

/**
 * The origin only reaches the bundle if the workflow exports it before the build,
 * and a kit that ships without one is indistinguishable from a kit that is
 * current — it simply never has anything to say. Nothing else would go red.
 */
describe("the release workflow stamps the origin before it builds the kit", () => {
  const release = fs.readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf-8");
  const ci = fs.readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf-8");

  it("derives the kit url from the version and the same origin the manifest uses", () => {
    expect(release).toContain("FISH_KIT_URL=${ORIGIN}/kit/fish-agent-kit-${VERSION}.zip");
    expect(release).toContain('FISH_UPDATE_MANIFEST_URL="${ORIGIN}/stable/manifest.json"');
  });

  it("exports it before `npm run build`, which is when it is read", () => {
    expect(release.indexOf("FISH_KIT_URL=")).toBeGreaterThan(-1);
    expect(release.indexOf("FISH_KIT_URL=")).toBeLessThan(release.indexOf("npm run build"));
  });

  it("does the same in CI, where the release pipeline is rehearsed", () => {
    expect(ci.indexOf("FISH_KIT_URL=")).toBeGreaterThan(-1);
    expect(ci.indexOf("FISH_KIT_URL=")).toBeLessThan(ci.indexOf("node scripts/build-fish-agent-kit.mjs"));
  });

  /**
   * The export can be right and the bundle still empty — a define dropped from
   * the esbuild call, a path computed wrong. `release:kit` would pack it happily,
   * and the shipped kit would answer "nothing to compare against" forever. So
   * both workflows ask the artifact itself, and this asks them to keep doing it.
   */
  it("refuses to pack a bundle whose origin did not land", () => {
    expect(release).toContain('grep -qF "${ORIGIN}/stable/manifest.json" dist/fish-agent-kit/tools/fish.cjs');
    expect(ci).toContain('grep -qF "${KIT_ORIGIN}/stable/manifest.json" dist/fish-agent-kit/tools/fish.cjs');
    expect(release.indexOf('grep -qF "${ORIGIN}/stable/manifest.json"')).toBeGreaterThan(release.indexOf("npm run build"));
  });
});

/**
 * `scripts/sync-to-public.sh` copies `.github/workflows` into the public repo
 * verbatim, so one file runs in two repositories — and both name the same origin,
 * which means a tag pushed in the development repo would publish over the live
 * site. Which repository may act is a repository variable, not code.
 *
 * This reads the files, so it cannot see a job added tomorrow without the guard;
 * the rule is stated at the top of each workflow for that reason.
 */
describe("one workflow, two repositories, one of which may act", () => {
  const read = (name: string) => fs.readFileSync(path.join(REPO, ".github/workflows", name), "utf-8");

  it("gates every job of the release workflow, existing conditions kept", () => {
    const guards = [...read("release.yml").matchAll(/^  [a-z][\w-]*:\n    if: (.+)$/gm)].map((m) => ` ${m[1]}`);
    expect(guards).toEqual([
      " vars.FISH_ACTIONS != 'off' && (github.event_name == 'push' || inputs.mode == 'release')",
      " vars.FISH_ACTIONS != 'off' && github.event_name == 'workflow_dispatch' && inputs.mode == 'promote'"
    ]);
  });

  it("gates the CI job", () => {
    expect(read("ci.yml")).toContain("  verify:\n    if: vars.FISH_ACTIONS != 'off'");
  });

  it("says where the switch is, in the file that gets synced", () => {
    for (const name of ["ci.yml", "release.yml"]) expect(read(name)).toContain("FISH_ACTIONS=off");
  });
});
