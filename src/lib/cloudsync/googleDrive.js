// Google Drive cloud sync (appDataFolder only — the single, owner-chosen option).
//
// Everything this module does over the network is a pinned https endpoint on a
// Google host. That is the explicit exception carved out in the project's
// outbound-request security policy: every other outbound request in the app
// must validate its host and refuse localhost/loopback/private/reserved
// addresses. Here the host allow-list IS the validation — a URL that is not
// https and not exactly one of the three Google OAuth/Drive hosts below is
// refused before a socket is opened (see assertGoogleEndpoint()).
//
// The module is deliberately dependency-free: node fetch + node:crypto only.
// The persistence layer (settingsRepo) and the backup sources (connections,
// combos, aliases) are imported lazily inside the functions that need them, so
// importing this module never opens the database — that keeps the pure helpers
// (auth URL, redaction, restore planning, crypto) testable without any state.
//
// Fail-open, like the rest of the repo: nothing here throws on bad stored
// state. Decrypting a blob that does not parse returns null; a Drive error is
// surfaced as a typed error for the route to turn into a friendly message.

import crypto from "node:crypto";

// ── pinned endpoints ─────────────────────────────────────────────────────────
//
// These three hosts are the whole world as far as this module is concerned.
// They are the "explicit Google OAuth endpoints" the security policy allows.

const GOOGLE_ALLOWED_HOSTS = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
]);

const AUTH_URL_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const LIST_URL = "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder";

// Drive appDataFolder: a hidden per-app folder only this app's OAuth client
// can see. Files listed/created with spaces=appDataFolder never appear in the
// user's Drive UI.
const APPDATA_FOLDER = "appDataFolder";

// One scope: the app's own hidden folder. Plus openid + email so the callback
// can record which Google account the backup belongs to.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
export const AUTH_SCOPES = [DRIVE_SCOPE, "openid", "email"];

// Every backup gets the same name; "newest by modifiedTime" is the restore pick.
export const BACKUP_FILE_NAME = "origin-router-backup.json";

// The user brings their own OAuth client (Google requires an owner-approved
// client for appDataFolder). Documented default placeholder — the signin route
// refuses to build an auth URL until a real client id is configured.
export const DEFAULT_CLIENT_ID = "PASTE-YOUR-GOOGLE-OAUTH-CLIENT-ID.apps.googleusercontent.com";

// Backup payload format version. Bumping it means restore has to be taught the
// old shape — until then everything is version 1.
export const BACKUP_VERSION = 1;

// ── outbound-request guard ───────────────────────────────────────────────────
//
// The security policy for server-side outbound requests: http/https only,
// validate the host, refuse localhost/loopback/private/reserved addresses —
// with an explicit exception for these Google OAuth/Drive endpoints. The
// exception is enforced as an allow-list, which is stricter than the general
// rule: not "any https public host", but exactly the pinned Google hosts.

/**
 * Refuse any URL that is not https and not one of the pinned Google hosts.
 * Called before every fetch in this module, so a refactored constant or an
 * interpolated id cannot quietly point the request somewhere else.
 */
export function assertGoogleEndpoint(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`cloudsync: refusing to fetch a malformed URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`cloudsync: refusing non-https endpoint ${parsed.protocol}`);
  }
  if (!GOOGLE_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`cloudsync: refusing non-Google host ${parsed.hostname}`);
  }
  return parsed;
}

/**
 * Google's token/Drive endpoints are pinned, but the redirect URI is a
 * user-visible input (it names THIS dashboard). It is never fetched, so the
 * private-host refusal of the general policy does not apply — a local app
 * legitimately redirects to its own loopback dashboard. Only the scheme is
 * checked: http/https, nothing exotic like javascript: or file:.
 */
function assertHttpRedirectUri(redirectUri) {
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error("cloudsync: redirect URI must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("cloudsync: redirect URI must be http or https");
  }
  return parsed;
}

// ── OAuth 2.0 authorization-code flow ────────────────────────────────────────
//
// The user supplies their own OAuth client id (Google does not allow a shared
// client for the drive.appdata scope). The flow is the classic server-side
// authorization code: buildAuthUrl → user signs in at Google → Google GETs our
// /api/cloudsync/callback with ?code= → exchangeCode() → refresh token stored
// encrypted. access_type=offline + prompt=consent are what make Google hand
// back a refresh token at all; without them a signed-in user gets only a
// short-lived access token and sync dies within the hour.

/**
 * Build the Google consent-screen URL.
 * @param {object} opts
 * @param {string} opts.clientId    the user's own OAuth client id
 * @param {string} opts.redirectUri e.g. <dashboard origin>/api/cloudsync/callback
 * @param {string} opts.state       opaque CSRF token, verified in the callback
 * @returns {string} URL to redirect the browser to
 */
export function buildAuthUrl({ clientId, redirectUri, state }) {
  if (!clientId || typeof clientId !== "string") {
    throw new Error("cloudsync: a Google OAuth client id is required");
  }
  if (!redirectUri) {
    throw new Error("cloudsync: a redirect URI is required");
  }
  assertHttpRedirectUri(redirectUri);

  const url = new URL(AUTH_URL_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // One joined scope string: drive.appdata + openid + email.
  url.searchParams.set("scope", AUTH_SCOPES.join(" "));
  // Offline access is the whole point: a long-lived refresh token to sync with.
  url.searchParams.set("access_type", "offline");
  // consent forces Google to re-issue a refresh token even for returning users.
  url.searchParams.set("prompt", "consent");
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Pull the email out of an id_token WITHOUT verifying the signature. This is
 * only used to label the backup ("synced with foo@gmail.com"); the token came
 * straight from Google over https, so there is no attacker-controlled issuer
 * to defend against, and adding a JWKS fetch would add a fourth endpoint for
 * zero security gain.
 */
export function decodeIdTokenEmail(idToken) {
  if (typeof idToken !== "string" || idToken.length === 0) return null;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json?.email === "string" ? json.email : null;
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization code for tokens. Returns the pieces we keep:
 * the refresh token (encrypted at rest), the first access token, its expiry,
 * and the account email decoded from the id_token.
 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri }, fetchImpl = fetch) {
  if (!code) throw new Error("cloudsync: missing authorization code");
  assertGoogleEndpoint(TOKEN_URL);

  const body = new URLSearchParams({
    client_id: clientId || "",
    client_secret: clientSecret || "",
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri || "",
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Google token exchange failed: ${data.error || res.status} ${data.error_description || ""}`.trim());
  }
  return {
    accessToken: data.access_token || "",
    refreshToken: data.refresh_token || "",
    expiresIn: Number(data.expires_in) || 0,
    idToken: data.id_token || "",
    scope: data.scope || "",
    email: decodeIdTokenEmail(data.id_token),
  };
}

/**
 * Trade a refresh token for a fresh access token. Google may or may not rotate
 * the refresh token; whatever comes back is returned so the caller can re-store it.
 */
export async function refreshToken({ clientId, clientSecret, refreshToken: token }, fetchImpl = fetch) {
  if (!token) throw new Error("cloudsync: no refresh token stored");
  assertGoogleEndpoint(TOKEN_URL);

  const body = new URLSearchParams({
    client_id: clientId || "",
    client_secret: clientSecret || "",
    refresh_token: token,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Google token refresh failed: ${data.error || res.status} ${data.error_description || ""}`.trim());
  }
  return {
    accessToken: data.access_token || "",
    expiresIn: Number(data.expires_in) || 0,
    // Google re-issues the refresh token only sometimes; keep the old one otherwise.
    refreshToken: data.refresh_token || token,
    email: decodeIdTokenEmail(data.id_token),
  };
}

// ── token encryption at rest ─────────────────────────────────────────────────
//
// The refresh token is a credential that outlives the process, so it never
// touches the settings table in plaintext. It is sealed with AES-256-GCM under
// a key derived (scrypt) from the machine's own secret material:
//   API_KEY_SECRET  — set in .env, the primary choice
//   MACHINE_ID_SALT — the salt already used for machine-bound ids
//   "origin-router-cloudsync" — last resort so the feature still works unset
// Same trust model as every other secret in this repo: encrypted at rest on
// disk, key held in the environment, not unbreakable against the OS admin.

const CRYPTO_SALT = "origin-router-cloudsync";
const KEY_CACHE_PREFIX = "_cloudsyncKey";

/**
 * Derive the 32-byte AES key with scrypt. Read at call time (not import time)
 * so tests can set the env vars first, and cached per secret so repeated syncs
 * do not pay the scrypt cost every time.
 */
export function deriveCloudsyncKey() {
  const secret =
    process.env.API_KEY_SECRET || process.env.MACHINE_ID_SALT || "origin-router-cloudsync";
  const cacheKey = `${KEY_CACHE_PREFIX}:${secret}`;
  if (globalThis[cacheKey]) return globalThis[cacheKey];
  const key = crypto.scryptSync(secret, CRYPTO_SALT, 32);
  globalThis[cacheKey] = key;
  return key;
}

/**
 * Seal a JSON value into a single string:
 *   v1.<iv base64url>.<authTag base64url>.<ciphertext base64url>
 * The version prefix leaves room to re-encrypt later without losing old blobs.
 */
export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveCloudsyncKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Open a sealed blob. Anything unexpected — wrong version, tampered tag,
 * garbage in the settings table — returns null instead of throwing: a bad
 * stored token should read as "signed out", not crash the dashboard.
 */
export function decryptJson(blob) {
  if (typeof blob !== "string") return null;
  const [version, ivPart, tagPart, dataPart] = blob.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveCloudsyncKey(),
      Buffer.from(ivPart, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    // Wrong key, tampered blob, or legacy junk — treat as "no credentials".
    return null;
  }
}

// ── credential redaction ─────────────────────────────────────────────────────
//
// The backup payload travels to the user's Google Drive. It must never carry
// an API key, OAuth token, client secret, password or cookie — not even the
// provider connection rows, whose whole `data` JSON column is credentials by
// weight. Redaction works as a pure transform: every field whose NAME looks
// like a credential is renamed to "<field>Redacted" holding "__redacted__",
// so (a) the value is gone, and (b) no field named apiKey/accessToken/… exists
// anywhere in the serialized payload — the shape itself proves it.

export const REDACTED_PLACEHOLDER = "__redacted__";

/**
 * Does this field name look like it carries a secret? Matched on a
 * letters-and-digits normalization of the name so "api_key", "apiKey" and
 * "API-KEY" all hit. Suffix matching keeps benign look-alikes safe:
 * "apiKeyOptionalWith" and "credentialForm" do NOT end in a credential word.
 * Proxy URLs are redacted too — they may embed user:pass@host basic auth.
 */
export function isCredentialKey(key) {
  const norm = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    norm.endsWith("apikey") ||
    norm.endsWith("accesstoken") ||
    norm.endsWith("refreshtoken") ||
    norm.endsWith("idtoken") ||
    norm === "token" ||
    norm.endsWith("clientsecret") ||
    norm.endsWith("secret") ||
    norm.endsWith("password") ||
    norm.endsWith("cookie") ||
    norm.endsWith("credential") ||
    norm.endsWith("credentials") ||
    norm.endsWith("samlcert") ||
    norm.endsWith("cert") ||
    norm.endsWith("proxyurl")
  );
}

/**
 * Deep-clone a value, renaming credential fields to placeholders. Arrays and
 * nested objects are walked; a credential field holding a scalar is replaced,
 * one holding an object is walked into (its inner scalars get renamed too).
 */
export function redactValue(value) {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      const scalar = typeof inner === "string" || typeof inner === "number";
      if (isCredentialKey(key) && scalar && inner !== "") {
        out[`${key}Redacted`] = REDACTED_PLACEHOLDER;
      } else {
        out[key] = redactValue(inner);
      }
    }
    return out;
  }
  return value;
}

// Settings keys that must never leave the machine, even renamed. `password` is
// the dashboard password hash (offline-crackable), `cloudsync` is this module's
// own state incl. the sealed token blob — a backup carrying it would be a
// credential loop.
const SETTINGS_DROP_KEYS = new Set(["password", "cloudsync"]);

/**
 * Redact one provider connection row for upload. Fields are copied through an
 * explicit allow-list rather than filtered: anything not on the list (the
 * `data` column spread — apiKey, accessToken, tokenType…) cannot survive.
 */
export function redactProviderConnection(conn) {
  if (!conn || typeof conn !== "object") return null;
  const out = {
    id: conn.id,
    provider: conn.provider,
    authType: conn.authType,
    name: conn.name,
    email: conn.email,
    priority: conn.priority,
    isActive: conn.isActive !== false,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
  for (const field of ["displayName", "globalPriority", "defaultModel", "testStatus"]) {
    if (conn[field] !== undefined && conn[field] !== null) out[field] = conn[field];
  }
  // Where a credential field existed, leave a placeholder marker behind —
  // renamed, never the original field name — so the uploaded row still shows
  // the user that a key was there and is deliberately not in the backup.
  for (const [key, value] of Object.entries(conn)) {
    const scalar = typeof value === "string" || typeof value === "number";
    if (isCredentialKey(key) && scalar && value !== "" && out[`${key}Redacted`] === undefined) {
      out[`${key}Redacted`] = REDACTED_PLACEHOLDER;
    }
  }
  if (conn.providerSpecificData && typeof conn.providerSpecificData === "object") {
    out.providerSpecificData = redactValue(conn.providerSpecificData);
  }
  return out;
}

/**
 * Redact the settings object for upload: drop the never-upload keys, then
 * deep-scrub credential-shaped fields out of whatever remains.
 */
export function redactSettings(settings) {
  const picked = {};
  for (const [key, value] of Object.entries(settings || {})) {
    if (SETTINGS_DROP_KEYS.has(key)) continue;
    picked[key] = value;
  }
  return redactValue(picked);
}

// ── backup payload ───────────────────────────────────────────────────────────
//
// The payload is the syncable slice of this install: settings (redacted),
// provider connections (redacted), combos, and model aliases. Repos are
// imported lazily so this module stays free of the database at import time.

/**
 * Build the uploadable backup. Everything credential-shaped is replaced by
 * placeholders before this returns — the result must be safe to hand to any
 * fetch as-is.
 */
export async function buildBackupPayload() {
  const { getSettings, exportSettings } = await import("@/lib/db/repos/settingsRepo");
  const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo");
  const { getCombos } = await import("@/lib/db/repos/combosRepo");
  const { getModelAliases } = await import("@/lib/db/repos/aliasRepo");

  const settings = await exportSettings().catch(() => ({}));
  const connections = await getProviderConnections().catch(() => []);
  const combos = await getCombos().catch(() => []);
  const aliases = await getModelAliases().catch(() => {});

  return {
    version: BACKUP_VERSION,
    origin: "origin-router",
    exportedAt: new Date().toISOString(),
    // exportSettings is the raw row (no defaults merged) — exactly what was
    // configured, nothing more.
    settings: redactSettings(settings),
    providerConnections: (connections || []).map(redactProviderConnection).filter(Boolean),
    combos: Array.isArray(combos) ? combos : [],
    aliases: aliases && typeof aliases === "object" ? aliases : {},
  };
}

// ── restore planning (pure) ──────────────────────────────────────────────────
//
// Restore is a MERGE, never a clobber: a combo name that already exists here
// stays as it is, an alias that is already set stays as it is. The planner is
// pure so it can be previewed before anything is written, and so tests can
// exercise it without a database.

// Settings keys restore never writes: the never-upload keys, plus every
// renamed credential placeholder ("oidcClientSecretRedacted" et al.) — those
// exist only to show the user what was left behind on the drive.
function restorableSettingsKeys(backupSettings) {
  return Object.keys(backupSettings || {}).filter((key) => {
    if (SETTINGS_DROP_KEYS.has(key)) return false;
    if (key.endsWith("Redacted")) return false;
    return true;
  });
}

/**
 * Plan a restore from a parsed backup against local state.
 * @param {object} backup   parsed backup payload
 * @param {object} local    { combos: [...], aliases: {...} } current state
 * @returns {object} the operations restore would perform, plus a summary
 */
export function planRestore(backup, local = {}) {
  const plan = {
    combosToCreate: [],
    combosSkipped: [],
    aliasesToSet: {},
    aliasesSkipped: 0,
    settingsPatch: {},
    connectionCount: 0,
    connectionNote:
      "Provider connections in the backup carry no credentials (they are redacted before upload), so they are not restored. Add the keys on this machine.",
    errors: [],
  };

  if (!backup || typeof backup !== "object") {
    plan.errors.push("Backup is empty or unreadable.");
    return plan;
  }
  // Only files this app wrote are restoreable: it must claim our origin and
  // carry a payload version. Anything else (hand-edited JSON, another tool's
  // export) is refused instead of half-imported.
  if (!Number.isFinite(Number(backup.version))) {
    plan.errors.push("This file is not an OriginRouter backup (missing version).");
    return plan;
  }
  if (backup.origin !== "origin-router") {
    plan.errors.push(`Backup is from "${backup.origin || "unknown"}", not OriginRouter.`);
    return plan;
  }

  // Combos: create the ones whose name is free; leave existing names alone.
  const localComboNames = new Set((local.combos || []).map((c) => c.name));
  for (const combo of Array.isArray(backup.combos) ? backup.combos : []) {
    if (!combo?.name) continue;
    if (localComboNames.has(combo.name)) {
      plan.combosSkipped.push({ name: combo.name, reason: "already exists" });
      continue;
    }
    plan.combosToCreate.push({
      name: combo.name,
      kind: combo.kind ?? null,
      models: Array.isArray(combo.models) ? combo.models : [],
      maxContextWindow: combo.maxContextWindow ?? null,
      displayName: combo.displayName ?? null,
    });
  }

  // Aliases: only fill names that have no alias here — the local mapping wins.
  const localAliases = local.aliases && typeof local.aliases === "object" ? local.aliases : {};
  for (const [alias, model] of Object.entries(backup.aliases || {})) {
    if (typeof model !== "string" || !model) continue;
    if (localAliases[alias] !== undefined) {
      plan.aliasesSkipped += 1;
      continue;
    }
    plan.aliasesToSet[alias] = model;
  }

  // Settings: every restorable key in the backup overwrites the local one only
  // when the backup actually has a value for it.
  for (const key of restorableSettingsKeys(backup.settings)) {
    const value = backup.settings[key];
    if (value === undefined) continue;
    plan.settingsPatch[key] = value;
  }

  plan.connectionCount = Array.isArray(backup.providerConnections)
    ? backup.providerConnections.length
    : 0;

  return plan;
}

/**
 * Apply a plan produced by planRestore. Only non-credential parts are written:
 * combos, aliases, and the settings patch (which was scrubbed at plan time).
 */
export async function applyRestorePlan(plan) {
  if (!plan || plan.errors?.length) {
    return { ok: false, error: plan?.errors?.[0] || "Nothing to apply." };
  }

  const { createCombo, getComboByName } = await import("@/lib/db/repos/combosRepo");
  const { setModelAlias } = await import("@/lib/db/repos/aliasRepo");
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo");

  let combosCreated = 0;
  const skipped = [];
  for (const combo of plan.combosToCreate || []) {
    try {
      if (await getComboByName(combo.name)) {
        skipped.push({ name: combo.name, reason: "already exists" });
        continue;
      }
      await createCombo(combo);
      combosCreated += 1;
    } catch (error) {
      skipped.push({ name: combo.name, reason: error.message });
    }
  }

  let aliasesSet = 0;
  for (const [alias, model] of Object.entries(plan.aliasesToSet || {})) {
    try {
      await setModelAlias(alias, model);
      aliasesSet += 1;
    } catch {
      // A single bad alias must not sink the restore; skip it.
    }
  }

  if (plan.settingsPatch && Object.keys(plan.settingsPatch).length) {
    await updateSettings(plan.settingsPatch);
  }

  return {
    ok: true,
    combosCreated,
    aliasesSet,
    settingsApplied: Object.keys(plan.settingsPatch || {}).length,
    skipped,
  };
}

// ── Drive API (appDataFolder) ────────────────────────────────────────────────
//
// All three calls run against pinned endpoints (checked with
// assertGoogleEndpoint before the request) and take an injectable fetch so
// tests can mock the network. A 401/403 on the appDataFolder space is common
// enough to deserve its own message: it means the OAuth client was not
// approved for the drive.appdata scope, which reads as "appDataFolder not
// accessible" rather than a generic failure.

/** Typed error so routes can map a Drive refusal to a helpful UI message. */
export class DriveAccessError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "DriveAccessError";
    this.status = status || 0;
    this.code = code || "drive_access_error";
  }
}

function driveAuthHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Turn a Drive refusal into the typed error; pass other responses through. */
function mapDriveFailure(res) {
  if (res.status === 401 || res.status === 403) {
    // 403 with an insufficient-permissions reason is the signature of a client
    // that cannot see appDataFolder (scope not approved in the OAuth consent screen).
    return new DriveAccessError(
      "Google Drive appDataFolder is not accessible. Make sure the OAuth client has the drive.appdata scope approved.",
      { status: res.status, code: "APPDATA_UNAVAILABLE" }
    );
  }
  if (res.status === 404) {
    return new DriveAccessError("The backup file disappeared from Google Drive.", {
      status: res.status,
      code: "BACKUP_MISSING",
    });
  }
  return new DriveAccessError(`Google Drive request failed (${res.status}).`, {
    status: res.status,
    code: "DRIVE_ERROR",
  });
}

/**
 * List backups in appDataFolder, newest first. Returns Drive file metadata
 * (id, name, modifiedTime) or an empty list when nothing is stored yet.
 */
export async function listBackups(accessToken, fetchImpl = fetch) {
  assertGoogleEndpoint(LIST_URL);
  const url = `${LIST_URL}&q=${encodeURIComponent(`name='${BACKUP_FILE_NAME}'`)}&orderBy=modifiedTime desc&pageSize=10&fields=${encodeURIComponent("files(id,name,modifiedTime,size)")}`;
  const res = await fetchImpl(url, { headers: driveAuthHeaders(accessToken) });
  if (!res.ok) throw mapDriveFailure(res);
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.files) ? data.files : [];
}

/**
 * Upload the backup payload as a multipart/related body: one JSON metadata
 * part (name + parents=[appDataFolder]) and one JSON content part. Each sync
 * creates a NEW file — restore always picks the newest by modifiedTime, and
 * keeping the old files costs nothing in the hidden per-app folder.
 */
export async function uploadBackup(accessToken, payload, fetchImpl = fetch) {
  assertGoogleEndpoint(UPLOAD_URL);
  const boundary = `originrouter-${crypto.randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: BACKUP_FILE_NAME,
    parents: [APPDATA_FOLDER],
    mimeType: "application/json",
  });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(payload),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const res = await fetchImpl(UPLOAD_URL, {
    method: "POST",
    headers: {
      ...driveAuthHeaders(accessToken),
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw mapDriveFailure(res);
  const data = await res.json().catch(() => ({}));
  return { fileId: data.id || null, modifiedTime: data.modifiedTime || null };
}

/**
 * Download one file's content from appDataFolder and parse it.
 */
export async function downloadBackup(fileId, accessToken, fetchImpl = fetch) {
  assertGoogleEndpoint(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetchImpl(url, { headers: driveAuthHeaders(accessToken) });
  if (!res.ok) throw mapDriveFailure(res);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new DriveAccessError("The stored backup is not valid JSON.", {
      code: "BACKUP_CORRUPT",
    });
  }
}

/**
 * Fetch the newest stored backup, or null when none exists yet.
 */
export async function fetchNewestBackup(accessToken, fetchImpl = fetch) {
  const files = await listBackups(accessToken, fetchImpl);
  if (!files.length) return null;
  return await downloadBackup(files[0].id, accessToken, fetchImpl);
}

// ── persisted state (settings table, key "cloudsync") ────────────────────────
//
// One JSON blob under the settings row holds everything this feature knows
// about itself. Non-secret facts (clientId, email, last sync time, last error)
// are stored plainly so the dashboard can show them; the ONLY secret material
// — the refresh/access token pair — lives inside `credentials`, sealed with
// encryptJson() above. Nothing else in the blob is sensitive.

/** Read this feature's blob, fail-open to an empty object. */
export async function getCloudsyncState() {
  try {
    const { getSettings } = await import("@/lib/db/repos/settingsRepo");
    const settings = await getSettings();
    const state = settings?.cloudsync;
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

/** Merge a patch into the blob and persist it. */
export async function saveCloudsyncState(patch) {
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo");
  const current = await getCloudsyncState();
  const next = { ...current, ...(patch || {}) };
  await updateSettings({ cloudsync: next });
  return next;
}

/** Forget the stored credentials (and nothing else) — the "sign out" path. */
export async function clearCloudsyncCredentials() {
  return saveCloudsyncState({ credentials: null, connected: false });
}

/**
 * Store the token pair from a code exchange or a refresh, encrypted.
 * Only the tokens go into the sealed blob; the email and client id stay
 * readable for the status card.
 */
export async function storeCloudTokens({ refreshToken: refresh, accessToken, expiresIn, email }) {
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : 0;
  const sealed = encryptJson({ refreshToken: refresh || "", accessToken: accessToken || "", expiresAt });
  await saveCloudsyncState({
    credentials: sealed,
    connected: Boolean(refresh || accessToken),
    ...(email ? { email } : {}),
  });
  return { refreshToken: refresh, accessToken, expiresAt };
}

/** Open the sealed blob. Returns null when signed out or undecryptable. */
export async function getCloudTokens() {
  const state = await getCloudsyncState();
  return decryptJson(state.credentials);
}

/**
 * A valid access token, refreshing through Google when the stored one is
 * missing or within a minute of expiring. Updates the stored pair when a
 * refresh happens so the next call starts warm. Throws DriveAccessError-style
 * errors upward — callers record them into lastError.
 */
export async function ensureAccessToken(fetchImpl = fetch) {
  const state = await getCloudsyncState();
  const tokens = await getCloudTokens();
  if (!tokens || (!tokens.refreshToken && !tokens.accessToken)) {
    throw new DriveAccessError("Not signed in to Google Drive.", { code: "NOT_SIGNED_IN" });
  }
  if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt > Date.now() + 60_000) {
    return tokens.accessToken;
  }
  const refreshed = await refreshToken(
    {
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      refreshToken: tokens.refreshToken,
    },
    fetchImpl
  );
  await storeCloudTokens({
    refreshToken: refreshed.refreshToken,
    accessToken: refreshed.accessToken,
    expiresIn: refreshed.expiresIn,
    email: refreshed.email,
  });
  return refreshed.accessToken;
}
