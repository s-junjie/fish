#!/usr/bin/env node
// Print the public halves of the release keys as environment assignments.
//
// The shell embeds public keys; the signature and the plugin trailers come from
// the private halves in the `release` environment. Deriving the public keys from
// the secrets at build time means the two cannot drift — publishing a plugin
// whose key the shipped shell does not trust is the failure this removes.
//
//   FISH_UPDATE_PRIVATE_JWK=... FISH_PLUGIN_PRIVATE_KEY=... \
//     node scripts/derive-release-keys.mjs >> "$GITHUB_ENV"
//
// Only public material is printed.

import { createPublicKey, createPrivateKey } from "node:crypto";
import { envKey } from "./lib/plugin-sign.mjs";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const updateRaw = process.env.FISH_UPDATE_PRIVATE_JWK;
if (!updateRaw) fail("FISH_UPDATE_PRIVATE_JWK is not set");

let updateJwk;
try {
  updateJwk = JSON.parse(updateRaw);
} catch {
  fail("FISH_UPDATE_PRIVATE_JWK is not valid JSON");
}
if (!updateJwk?.d) fail("FISH_UPDATE_PRIVATE_JWK carries no private JWK");

let updatePublic;
try {
  updatePublic = createPublicKey(createPrivateKey({ key: updateJwk, format: "jwk" })).export({
    format: "jwk"
  });
} catch {
  fail("FISH_UPDATE_PRIVATE_JWK is not a usable P-256 key");
}

const plugin = (() => {
  try {
    return envKey();
  } catch (error) {
    fail(error.message);
  }
})();
if (!plugin) fail("FISH_PLUGIN_PRIVATE_KEY is not set");

if (updatePublic.x === plugin.publicKey.x && updatePublic.y === plugin.publicKey.y) {
  fail("the update key and the plugin key are the same keypair — they must be different");
}

console.log(`FISH_UPDATE_PUBLIC_KEY=${JSON.stringify(updatePublic)}`);
console.log(`FISH_PLUGIN_PUBLIC_KEY=${JSON.stringify(plugin.publicKey)}`);
