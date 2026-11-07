// The server side of the per-key rate limiting: it reads the budgets from the
// settings, checks them and turns a breach into a 429 for the client.

import { NextResponse } from "next/server";
import { getSettings, getApiKeyByKey } from "@/lib/localDb";
import { checkKeyRateLimit as checkKeyRateLimitBucket, normalizeKeyLimits } from "@/lib/keyRateLimit";
import { extractClientApiKey } from "@/sse/services/keyAccess";

/**
 * The budget of one key: its own entry if it has one, otherwise the default
 * every key inherits. An entry of zeros means "no limit" - it does not fall
 * back to the default, so a key can always be freed.
 */
export async function getKeyLimitsFor(keyId) {
  const settings = (await getSettings()) || {};
  const own = settings.keyRateLimits?.[keyId];
  if (own && typeof own === "object") return normalizeKeyLimits(own);
  return normalizeKeyLimits(settings.keyRateLimitDefaults);
}

/**
 * Checks the request against the budget of its key.
 *
 * @returns {Response|null} a 429 when the budget is spent, null when the
 *          request may run.
 */
export async function enforceKeyRateLimit(request) {
  // The limiter must never take the router down: if anything in here fails,
  // the request goes through unthrottled.
  try {
    return await checkKeyRateLimit(request);
  } catch {
    return null;
  }
}

async function checkKeyRateLimit(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null; // no key: nothing to limit
  const record = await getApiKeyByKey(apiKey);
  if (!record) return null; // unknown key: the auth layer deals with it

  const limits = await getKeyLimitsFor(record.id);
  const result = checkKeyRateLimitBucket(record.id, limits);
  if (result.allowed) return null;

  const retryAfter = Math.max(Math.ceil((result.retryAfterMs || 1000) / 1000), 1);
  const headers = {
    "Retry-After": String(retryAfter),
    "X-RateLimit-Limit": String(result.limit ?? ""),
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(Math.ceil((result.resetAt || Date.now()) / 1000)),
  };

  return NextResponse.json(
    {
      error: {
        message: `Rate limit reached for this key (${result.reason}). Try again in ${retryAfter}s.`,
        type: "rate_limit_error",
        code: "key_rate_limit",
        reason: result.reason,
      },
    },
    { status: 429, headers }
  );
}
