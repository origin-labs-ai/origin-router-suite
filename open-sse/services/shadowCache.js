// Shadow Cache — "Context Shadow-Caching & Zero-Spill Sync".
//
// A local response cache for temperature=0 chat requests. Deterministic
// requests (same model, same context, sampling frozen) must produce the same
// answer, so the first answer is kept and replayed as a "shadow" on repeats —
// agents re-send near-identical contexts constantly (retries, parallel tools,
// resumed sessions), and every shadow hit is an upstream call that never
// happens ("zero spill").
//
// Deliberate scope limits:
// - NOT wired into chatCore here; handlers opt in by importing this module.
// - Only engages when the request is actually deterministic: temperature 0 or
//   absent, non-streaming, no tools. Anything else is passed through untouched.
// - Keys are bounded: the full first 4 and last 6 messages shape the key, the
//   middle contributes only its roles. Long agent transcripts therefore hash
//   to stable, small inputs instead of the whole payload.
// - Responses at rest are encrypted (AES-256-GCM, key derived via scrypt from
//   the deployment's secret env) — a stolen cache file leaks no conversations.
// - Fail-open everywhere: any crypto/IO error degrades to a cache miss, never
//   an exception into the request path.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// LRU cap + entry TTL. 200 full chat responses is generous for one machine
// while keeping the memory footprint and the persist blob bounded.
const MAX_ENTRIES = 200;
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Key shaping: first 4 messages verbatim, last 6 verbatim, the middle only
// contributes `{role}` — the shape of the conversation, not its bulk.
const KEY_HEAD_MESSAGES = 4;
const KEY_TAIL_MESSAGES = 6;

// Encryption material. The key is derived lazily once and cached; the salt is
// a fixed domain separator (its job is separation, not secrecy — the secret
// comes from the env chain below).
const KDF_SALT = "origin-router-shadow-cache";
const MAGIC = "ORSHv1"; // blob header so foreign/corrupt files fail fast

function deriveKey() {
  // Deployment secret chain: the API-key pepper, then the machine salt, then a
  // fixed dev fallback so local runs still work out of the box.
  const secret = process.env.API_KEY_SECRET || process.env.MACHINE_ID_SALT || "origin-router-shadow";
  return crypto.scryptSync(secret, KDF_SALT, 32);
}

let cachedKey = null;
function getKey() {
  if (!cachedKey) cachedKey = deriveKey();
  return cachedKey;
}

// Encrypt a string to "ORSHv1:iv:tag:ciphertext" (all base64). Throws only on
// crypto failure — callers treat that as "cannot persist" and move on.
function encryptString(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

// Inverse of encryptString; returns null for anything that is not our blob
// (wrong magic, tampered tag, garbage) — the caller treats null as a miss.
function decryptString(blob) {
  try {
    if (typeof blob !== "string" || !blob.startsWith(MAGIC + ":")) return null;
    const [, ivB64, tagB64, ctB64] = blob.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eligibility + key derivation
// ---------------------------------------------------------------------------

// Bypass header (lowercase keys): "x-shadow-cache: off" forces a pass-through
// for clients that need a guaranteed fresh upstream call.
const BYPASS_HEADER = "x-shadow-cache";
const BYPASS_VALUE = "off";

function bypassRequested(headers) {
  if (!headers || typeof headers !== "object") return false;
  // Scan case-insensitively: raw Node headers arrive lowercase, Next headers
  // are case-insensitive proxies, and hand-rolled test objects are neither.
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() !== BYPASS_HEADER) continue;
    if (typeof v === "string" && v.trim().toLowerCase() === BYPASS_VALUE) return true;
  }
  return false;
}

/**
 * Is this request cacheable at all? All four must hold:
 * - model present and messages non-empty (nothing to key on otherwise)
 * - temperature === 0 or undefined (deterministic sampling)
 * - stream !== true (a cached response replays as JSON, not SSE)
 * - no tools (tool-call loops must not be replayed from yesterday's state)
 */
function shadowEligible(model, body, headers) {
  if (!model || !body || typeof body !== "object") return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  if (bypassRequested(headers)) return false;
  const t = body.temperature;
  if (t !== 0 && t !== undefined) return false;
  if (body.stream === true) return false;
  if (Array.isArray(body.tools) ? body.tools.length > 0 : body.tools != null) return false;
  return true;
}

/**
 * Cache key: SHA-256 over a canonical JSON of {model, shaped messages,
 * temperature, top_p}. Head/tail shaping keeps keys bounded: the first 4 and
 * last 6 messages are taken in full, middle messages collapse to {role} — so
 * two transcripts that share their bookends and conversation shape share the
 * shadow, and no key grows with the transcript.
 */
function shadowKey(model, body) {
  const messages = body.messages;
  let shaped;
  if (messages.length <= KEY_HEAD_MESSAGES + KEY_TAIL_MESSAGES) {
    shaped = messages;
  } else {
    shaped = [
      ...messages.slice(0, KEY_HEAD_MESSAGES),
      ...messages.slice(KEY_HEAD_MESSAGES, messages.length - KEY_TAIL_MESSAGES).map((m) => ({ role: m?.role })),
      ...messages.slice(-KEY_TAIL_MESSAGES),
    ];
  }
  const canonical = JSON.stringify({
    model,
    messages: shaped,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Store: in-memory LRU + optional encrypted persistence
// ---------------------------------------------------------------------------

// Map preserves insertion order → first key is the LRU's least-recently-used.
// Bounded by MAX_ENTRIES; every entry carries its storedAt for TTL checks.
const lru = new Map(); // key -> { value: object, storedAt: number }

// Counters for shadowStats(). Bounded by nature (plain numbers).
const counters = { hits: 0, misses: 0, stores: 0, evictions: 0, bypasses: 0, decryptFailures: 0 };

// Drop expired entries. Called on writes/reads instead of a timer — same
// lazy-sweep style as thoughtSignatureStore.js, no timers to leak.
function sweepExpired() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of lru) {
    if (entry.storedAt <= cutoff) lru.delete(key);
  }
}

// Enforce the cap by evicting the least-recently-used entries.
function evictOverCap() {
  while (lru.size > MAX_ENTRIES) {
    const oldest = lru.keys().next().value;
    if (oldest === undefined) break;
    lru.delete(oldest);
    counters.evictions++;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
//
// Default store: one encrypted blob file under the writable data dir (same
// writable-dir resolution the other open-sse file consumers use). The whole
// cache is ONE blob on purpose — responses are small, 200 entries max, and a
// single file keeps "zero spill" honest: nothing plaintext ever hits disk.
//
// setShadowCacheStore(fn) replaces the file store entirely (used by tests and
// by hosts that want their own storage). Contract for fn:
//   fn({ operation: "read" })             -> blob string | null (or a Promise)
//   fn({ operation: "write", data: blob })-> anything (or a Promise)
// Both directions are fire-and-forget: persistence problems never surface
// into the request path.

const DEFAULT_BLOB_FILE = "shadow-cache-v1.bin";

function defaultRead() {
  try {
    const file = path.join(getWritableDataDir(), DEFAULT_BLOB_FILE);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function defaultWrite(blob) {
  try {
    fs.writeFileSync(path.join(getWritableDataDir(), DEFAULT_BLOB_FILE), blob, "utf8");
  } catch {
    // Fail-open: an unwritable data dir must not break caching or requests.
  }
}

let storeFn = null; // when set, replaces the default file store

export function setShadowCacheStore(fn) {
  storeFn = typeof fn === "function" ? fn : null;
  if (!storeFn) return;
  // Swap the store → re-hydrate from whatever the new store holds, so a host
  // can plug in its own backend after import and still see prior entries.
  hydrated = true;
  readThroughStore();
}

function readThroughStore() {
  const fn = storeFn || null;
  try {
    if (fn) {
      const res = fn({ operation: "read" });
      if (res && typeof res.then === "function") {
        res.then((blob) => hydrateFromBlob(blob)).catch(() => {});
        return; // async hydration; the LRU serves misses meanwhile
      }
      return hydrateFromBlob(res);
    }
    return hydrateFromBlob(defaultRead());
  } catch {
    // Fail-open: unreadable store just means a cold cache.
  }
}

function writeThroughStore(blob) {
  try {
    if (storeFn) {
      const res = storeFn({ operation: "write", data: blob });
      if (res && typeof res.catch === "function") res.catch(() => {});
      return;
    }
    defaultWrite(blob);
  } catch {
    // Fail-open.
  }
}

// Load the persisted blob into the LRU. Keeps the NEWEST MAX_ENTRIES non-
// expired entries so an oversized/clock-skewed blob cannot blow the cap.
function hydrateFromBlob(blob) {
  const plain = decryptString(blob);
  if (!plain) {
    if (blob) counters.decryptFailures++;
    return;
  }
  try {
    const parsed = JSON.parse(plain);
    const entries = Object.entries(parsed?.entries || {});
    // Newest first, then cap — insertion order after this = recency order.
    entries.sort((a, b) => (b[1]?.storedAt || 0) - (a[1]?.storedAt || 0));
    const cutoff = Date.now() - TTL_MS;
    for (const [key, entry] of entries) {
      if (!entry || typeof entry.storedAt !== "number" || entry.storedAt <= cutoff) continue;
      if (lru.size >= MAX_ENTRIES) break;
      lru.set(key, { value: entry.value, storedAt: entry.storedAt });
    }
  } catch {
    // Corrupt payload → start cold. Never throw out of hydration.
  }
}

let hydrated = false;
function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  readThroughStore();
}

// Serialize the current (non-expired) LRU and persist it encrypted.
function persistNow() {
  sweepExpired();
  try {
    const entries = {};
    for (const [key, entry] of lru) entries[key] = { value: entry.value, storedAt: entry.storedAt };
    writeThroughStore(encryptString(JSON.stringify({ entries })));
  } catch {
    // Fail-open: persistence is best-effort by contract.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a cached response for a chat request. Returns the stored response
 * JSON verbatim, or null on miss/ineligible/error — callers proceed upstream
 * on null without caring why.
 *
 * @param {string} model - Resolved model id (part of the key)
 * @param {object} body - Parsed chat request body
 * @param {{headers?: object}} [opts] - Raw client headers (bypass check)
 * @returns {object|null} Cached response JSON or null
 */
export function lookupShadow(model, body, opts = {}) {
  try {
    if (bypassRequested(opts?.headers)) {
      counters.bypasses++;
      return null;
    }
    if (!shadowEligible(model, body, opts?.headers)) return null;
    ensureHydrated();
    sweepExpired();

    const key = shadowKey(model, body);
    const entry = lru.get(key);
    if (!entry) {
      counters.misses++;
      return null;
    }
    if (entry.storedAt <= Date.now() - TTL_MS) {
      lru.delete(key);
      counters.misses++;
      return null;
    }
    // LRU refresh: delete + re-set moves the key to the back of the Map.
    lru.delete(key);
    lru.set(key, entry);
    counters.hits++;
    return entry.value;
  } catch {
    // Fail-open: a broken cache must never break the request path.
    counters.misses++;
    return null;
  }
}

/**
 * Store a response for a chat request. Silently ignores ineligible requests
 * (non-zero temperature, streaming, tools, bypass header). Persisting is
 * fire-and-forget and fail-open.
 *
 * @param {string} model - Resolved model id (part of the key)
 * @param {object} body - Parsed chat request body
 * @param {object} responseJson - The response that answers this exact request
 * @param {{headers?: object}} [opts] - Raw client headers (bypass check)
 * @returns {boolean} true when the response was cached
 */
export function storeShadow(model, body, responseJson, opts = {}) {
  try {
    if (!shadowEligible(model, body, opts?.headers)) return false;
    if (!responseJson || typeof responseJson !== "object") return false;
    ensureHydrated();

    const key = shadowKey(model, body);
    // Delete first so a re-store also refreshes LRU recency.
    lru.delete(key);
    lru.set(key, { value: responseJson, storedAt: Date.now() });
    evictOverCap();
    counters.stores++;
    persistNow();
    return true;
  } catch {
    // Fail-open: caching is an optimization, never a correctness dependency.
    return false;
  }
}

/**
 * Aggregate counters for the dashboard/debugging. All numbers, no entries —
 * the blob content never leaves the process.
 */
export function shadowStats() {
  sweepExpired();
  return {
    entries: lru.size,
    cap: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hits: counters.hits,
    misses: counters.misses,
    stores: counters.stores,
    evictions: counters.evictions,
    bypasses: counters.bypasses,
    decryptFailures: counters.decryptFailures,
    persisted: storeFn ? "custom" : "file",
  };
}

/**
 * Drop everything (memory only; the next store re-persists the now-empty
 * blob). Useful for tests and for an explicit "forget all shadows".
 */
export function clearShadowCache() {
  lru.clear();
  hydrated = false;
  for (const k of Object.keys(counters)) counters[k] = 0;
}
