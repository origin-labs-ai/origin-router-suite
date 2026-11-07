// Per-key rate limiting.
//
// Every API key can carry its own budget: requests per minute, tokens per
// minute, tokens per day and how many requests may run at the same time.
// The counters live in this process - the router is local and single process,
// so there is nothing to share with anybody.
//
// A limit of 0 means "no limit". That is the default for every key, so the
// feature costs nothing until a key is given a budget.

export const WINDOW_MS = 60_000;
export const DAY_MS = 86_400_000;

// A request that never finishes (a crashed handler, or one that failed
// before it could record any usage) must not hold its slot forever, so a slot
// is released after this long.
export const SLOT_TIMEOUT_MS = 120_000;

export const KEY_LIMIT_FIELDS = ["rpm", "tpm", "dailyTokens", "maxConcurrent"];

export function normalizeKeyLimits(limits) {
  const out = { rpm: 0, tpm: 0, dailyTokens: 0, maxConcurrent: 0 };
  for (const field of KEY_LIMIT_FIELDS) {
    const value = Number(limits?.[field]);
    out[field] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return out;
}

export function hasKeyLimits(limits) {
  const normalized = normalizeKeyLimits(limits);
  return KEY_LIMIT_FIELDS.some((field) => normalized[field] > 0);
}

// The per-key counters. One bucket per key id.
const buckets = new Map();

function bucketFor(keyId) {
  let bucket = buckets.get(keyId);
  if (!bucket) {
    bucket = {
      requests: [],
      inFlight: [],
      windowTokens: 0,
      windowStart: 0,
      dayTokens: 0,
      dayStart: 0,
    };
    buckets.set(keyId, bucket);
  }
  return bucket;
}

function prune(bucket, now) {
  bucket.requests = bucket.requests.filter((ts) => now - ts < WINDOW_MS);
  bucket.inFlight = bucket.inFlight.filter((ts) => now - ts < SLOT_TIMEOUT_MS);
  if (now - bucket.windowStart >= WINDOW_MS) {
    bucket.windowStart = now;
    bucket.windowTokens = 0;
  }
  if (now - bucket.dayStart >= DAY_MS) {
    bucket.dayStart = now;
    bucket.dayTokens = 0;
  }
}

/**
 * Checks a key against its budget and takes a slot when the request may run.
 *
 * @returns {{allowed: boolean, reason?: string, limit?: number, remaining?: number,
 *            resetAt?: number, retryAfterMs?: number}}
 */
export function checkKeyRateLimit(keyId, limits, options = {}) {
  const now = options.now ?? Date.now();
  if (!keyId) return { allowed: true };
  const normalized = normalizeKeyLimits(limits);
  if (!hasKeyLimits(normalized)) return { allowed: true };

  const bucket = bucketFor(keyId);
  prune(bucket, now);

  if (normalized.rpm > 0 && bucket.requests.length >= normalized.rpm) {
    const resetAt = bucket.requests[0] + WINDOW_MS;
    return {
      allowed: false,
      reason: "rpm",
      limit: normalized.rpm,
      remaining: 0,
      resetAt,
      retryAfterMs: Math.max(resetAt - now, 1),
    };
  }

  if (normalized.maxConcurrent > 0 && bucket.inFlight.length >= normalized.maxConcurrent) {
    return {
      allowed: false,
      reason: "maxConcurrent",
      limit: normalized.maxConcurrent,
      remaining: 0,
      resetAt: now + 1000,
      retryAfterMs: 1000,
    };
  }

  if (normalized.tpm > 0 && bucket.windowTokens >= normalized.tpm) {
    const resetAt = bucket.windowStart + WINDOW_MS;
    return {
      allowed: false,
      reason: "tpm",
      limit: normalized.tpm,
      remaining: 0,
      resetAt,
      retryAfterMs: Math.max(resetAt - now, 1),
    };
  }

  if (normalized.dailyTokens > 0 && bucket.dayTokens >= normalized.dailyTokens) {
    const resetAt = bucket.dayStart + DAY_MS;
    return {
      allowed: false,
      reason: "dailyTokens",
      limit: normalized.dailyTokens,
      remaining: 0,
      resetAt,
      retryAfterMs: Math.max(resetAt - now, 1),
    };
  }

  bucket.requests.push(now);
  bucket.inFlight.push(now);
  return {
    allowed: true,
    limit: normalized.rpm || null,
    remaining: normalized.rpm > 0 ? Math.max(normalized.rpm - bucket.requests.length, 0) : null,
  };
}

// Called when the request is done: the slot is freed and the tokens are
// added to the budgets.
export function finishKeyRequest(keyId, tokens = 0, options = {}) {
  if (!keyId) return;
  const now = options.now ?? Date.now();
  const bucket = bucketFor(keyId);
  // The oldest in-flight slot belongs to this request.
  bucket.inFlight.shift();
  if (tokens > 0) {
    prune(bucket, now);
    bucket.windowTokens += tokens;
    bucket.dayTokens += tokens;
  }
}

// What the dashboard shows for one key.
export function keyLimitSnapshot(keyId, limits, options = {}) {
  const now = options.now ?? Date.now();
  const normalized = normalizeKeyLimits(limits);
  const bucket = buckets.get(keyId);
  const requests = bucket ? bucket.requests.filter((ts) => now - ts < WINDOW_MS).length : 0;
  const inFlight = bucket ? bucket.inFlight.filter((ts) => now - ts < SLOT_TIMEOUT_MS).length : 0;
  return {
    limits: normalized,
    requestsThisMinute: requests,
    inFlight,
    tokensThisMinute: bucket?.windowTokens || 0,
    tokensToday: bucket?.dayTokens || 0,
    rpmRemaining: normalized.rpm > 0 ? Math.max(normalized.rpm - requests, 0) : null,
    tpmRemaining: normalized.tpm > 0 ? Math.max(normalized.tpm - (bucket?.windowTokens || 0), 0) : null,
    dailyRemaining:
      normalized.dailyTokens > 0 ? Math.max(normalized.dailyTokens - (bucket?.dayTokens || 0), 0) : null,
    concurrentRemaining:
      normalized.maxConcurrent > 0 ? Math.max(normalized.maxConcurrent - inFlight, 0) : null,
  };
}

// Forgets the counters of one key (or of every key).
export function resetKeyLimits(keyId) {
  if (keyId) buckets.delete(keyId);
  else buckets.clear();
}
