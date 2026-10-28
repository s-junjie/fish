import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Read and verify the signed manifest without a browser.
 *
 * The shell verifies the payload STRING with WebCrypto; this is the same check
 * on the other side of the wire, so a release pipeline fails before it publishes
 * something the client would refuse. `ieee-p1363` is WebCrypto's raw r‖s
 * signature, not DER.
 */
export function parseEnvelope(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  if (typeof envelope?.payload !== "string" || typeof envelope?.sig !== "string") {
    throw new Error("manifest is not a { payload, sig } envelope");
  }
  return envelope;
}

export function verifyManifest(text, publicJwk) {
  const envelope = parseEnvelope(text);
  let key;
  try {
    key = createPublicKey({ key: publicJwk, format: "jwk" });
  } catch {
    throw new Error("public key is not a usable JWK");
  }
  const valid = cryptoVerify(
    "sha256",
    Buffer.from(envelope.payload, "utf8"),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(envelope.sig, "base64")
  );
  if (!valid) throw new Error("manifest signature is invalid");
  try {
    return JSON.parse(envelope.payload);
  } catch {
    throw new Error("manifest payload is not valid JSON");
  }
}

/** Shape checks shared by the assembler and the post-deploy verifier. */
export function assertPayload(payload, expected) {
  if (payload?.app !== "fish") {
    throw new Error(`manifest is for "${String(payload?.app)}", not fish`);
  }
  if (payload.version !== expected.version) {
    throw new Error(`manifest names v${payload.version}, expected v${expected.version}`);
  }
  if (payload.url !== expected.url) {
    throw new Error(`manifest names ${payload.url}, expected ${expected.url}`);
  }
  if (payload.sha256 !== expected.sha256) {
    throw new Error(`manifest hash ${payload.sha256} does not match the shell ${expected.sha256}`);
  }
}
