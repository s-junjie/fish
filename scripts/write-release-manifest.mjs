#!/usr/bin/env node
// Write the release manifest an auto-updating FISH checks against, and sign it.
//
// A "release" here is one shell file at one URL. The manifest is what lets a
// running build decide whether that URL holds something newer AND prove it: the
// signature covers the payload string, and the payload names the file's SHA-256.
// Neither half is secret — the public key ships inside the shell — but both are
// required, because a manifest fetched over an ordinary HTTPS request is
// otherwise just a suggestion from whoever answered it.
//
//   node scripts/write-release-manifest.mjs --url https://host/fish/index.html
//   FISH_UPDATE_PRIVATE_JWK='{"kty":"EC",…}' node scripts/write-release-manifest.mjs \
//     --url https://host/fish/index.html --out dist/manifest.json
//
// The private key is read from the environment and never written anywhere by
// this script, including to `--out`.

import { createHash } from "node:crypto";
import { createPublicKey, createPrivateKey, sign as cryptoSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RELEASE_APP_ID = "fish";

const args = process.argv.slice(2);
const opts = { url: "", out: "dist/manifest.json", shell: "dist/index.html", printKey: false, generate: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") opts.url = args[++i] ?? "";
  else if (args[i] === "--out") opts.out = args[++i] ?? opts.out;
  else if (args[i] === "--shell") opts.shell = args[++i] ?? opts.shell;
  else if (args[i] === "--print-public-key") opts.printKey = true;
  else if (args[i] === "--generate-key") opts.generate = true;
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: node scripts/write-release-manifest.mjs --url <release-url> [options]

  --url <url>            Where the built shell will be published. Required.
  --shell <path>         Shell to hash. Default dist/index.html
  --out <path>           Manifest to write. Default dist/manifest.json
  --print-public-key     Print the public JWK to embed in the build.
  --generate-key         Print a fresh P-256 keypair and exit.

Signing reads FISH_UPDATE_PRIVATE_JWK (a JWK as JSON). The version is read from
package.json, which is the only place it lives (AGENTS.md §10).`);
    process.exit(0);
  } else {
    console.error(`error: unknown argument ${args[i]}`);
    process.exit(1);
  }
}

if (opts.generate) {
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const priv = pair.privateKey.export({ format: "jwk" });
  const pub = pair.publicKey.export({ format: "jwk" });
  console.log("Private key — keep this OUT of the repo and out of any shell history:");
  console.log(JSON.stringify(priv));
  console.log("\nPublic key — this is what the build embeds:");
  console.log(JSON.stringify(pub));
  process.exit(0);
}

if (!opts.url) {
  console.error("error: --url is required (where the shell will be published)");
  process.exit(1);
}
let url;
try {
  url = new URL(opts.url);
} catch {
  console.error(`error: --url is not an absolute URL: ${opts.url}`);
  process.exit(1);
}
if (url.protocol !== "https:" && url.protocol !== "http:") {
  console.error(`error: --url must be http(s), got ${url.protocol}`);
  process.exit(1);
}

const privateJwk = process.env.FISH_UPDATE_PRIVATE_JWK;
if (!privateJwk) {
  console.error(
    "error: FISH_UPDATE_PRIVATE_JWK is not set.\n" +
      "       Run with --generate-key once to make a pair, and keep the private half offline."
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
const shellPath = path.resolve(process.cwd(), opts.shell);
if (!fs.existsSync(shellPath)) {
  console.error(`error: shell not found: ${opts.shell} — run "npm run build" first`);
  process.exit(1);
}

const bytes = fs.readFileSync(shellPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");

// The payload is signed as a STRING, and the same string is what ships, because
// that is what the shell verifies. Re-serialising it on the reader's side would
// make the signature depend on key order and spacing.
const payload = JSON.stringify(
  { app: RELEASE_APP_ID, version: pkg.version, url: url.toString(), sha256 },
  null,
  2
);

// WebCrypto's ECDSA signature is raw r‖s, which is also what
// `crypto.subtle.verify` expects; a DER envelope would need unwrapping in the
// browser for no gain.
const key = createPrivateKey({ key: JSON.parse(privateJwk), format: "jwk" });
const sig = cryptoSign("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "ieee-p1363" });

const manifest = JSON.stringify({ payload, sig: sig.toString("base64") }, null, 2);
const outPath = path.resolve(process.cwd(), opts.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, manifest + "\n");

if (opts.printKey) {
  const pub = createPublicKey(key).export({ format: "jwk" });
  console.log("FISH_UPDATE_PUBLIC_KEY (embed in the build):");
  console.log(JSON.stringify(pub));
  console.log("");
}

console.log(`manifest  ${path.relative(process.cwd(), outPath)}`);
console.log(`version   ${pkg.version}`);
console.log(`url       ${url}`);
console.log(`sha256    ${sha256}  (${bytes.length} bytes of ${path.relative(process.cwd(), shellPath)})`);