/**
 * The update path, in the order it runs.
 *
 * `checkForUpdate` proves there is something newer; `applyUpdate` proves the
 * newer thing and pours the current document into it. Nothing here writes
 * without being called with a document, and nothing here is reached unless
 * `config.isConfigured()` holds — a build with no release endpoint carries this
 * code and never enters it.
 */
export {
  AUTO_CHECK_KEY,
  JUST_UPDATED_KEY,
  MANIFEST_URL_KEY,
  autoCheckEnabled,
  canVerify,
  consumeJustUpdated,
  isConfigured,
  isEmbedded,
  isOpaqueOrigin,
  manifestUrl,
  rememberJustUpdated,
  releasePublicKey,
  setAutoCheckEnabled
} from "./config";
export {
  checkAtLaunch,
  checkForUpdate,
  configuredSources,
  disabledReason,
  type DisabledReason,
  type UpdateCheck,
  type UpdateSources
} from "./check";
export {
  applyUpdate,
  assertUsableShell,
  buildUpdatedFile,
  downloadShell,
  type ApplyOutcome
} from "./apply";
export {
  RELEASE_APP_ID,
  UpdateError,
  compareVersions,
  isNewer,
  sha256Hex,
  verifyDigest,
  verifyEnvelope,
  type ReleasePayload
} from "./manifest";