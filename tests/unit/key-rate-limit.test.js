// The per-key budgets: requests per minute, tokens per minute, tokens per
// day and how many requests may run at the same time. A limit of 0 means
// "no limit", so a key without a budget is never slowed down.
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkKeyRateLimit,
  finishKeyRequest,
  keyLimitSnapshot,
  normalizeKeyLimits,
  resetKeyLimits,
  hasKeyLimits,
  WINDOW_MS,
  DAY_MS,
} from "../../src/lib/keyRateLimit.js";

const KEY = "key-1";

describe("per-key rate limiting", () => {
  beforeEach(() => {
    resetKeyLimits();
  });

  it("never slows a key down without a budget", () => {
    expect(hasKeyLimits({})).toBe(false);
    for (let i = 0; i < 100; i++) {
      expect(checkKeyRateLimit(KEY, {}).allowed).toBe(true);
    }
  });

  it("turns a broken budget into zeros", () => {
    expect(normalizeKeyLimits({ rpm: "abc", tpm: -5, dailyTokens: 10.7, maxConcurrent: 2 })).toEqual({
      rpm: 0,
      tpm: 0,
      dailyTokens: 10,
      maxConcurrent: 2,
    });
  });

  it("stops a key at its request limit and lets it go after the window", () => {
    const now = 1_700_000_000_000;
    const limits = { rpm: 3 };

    for (let i = 0; i < 3; i++) {
      expect(checkKeyRateLimit(KEY, limits, { now }).allowed).toBe(true);
    }

    const blocked = checkKeyRateLimit(KEY, limits, { now: now + 1000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("rpm");
    expect(blocked.limit).toBe(3);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // The window slides: the first request is old enough now.
    expect(checkKeyRateLimit(KEY, limits, { now: now + WINDOW_MS + 1 }).allowed).toBe(true);
  });

  it("counts the requests of one minute only", () => {
    const now = 1_700_000_000_000;
    const limits = { rpm: 2 };
    checkKeyRateLimit(KEY, limits, { now });
    checkKeyRateLimit(KEY, limits, { now: now + 30_000 });
    expect(checkKeyRateLimit(KEY, limits, { now: now + 40_000 }).allowed).toBe(false);
    // Both are older than a minute now.
    expect(checkKeyRateLimit(KEY, limits, { now: now + WINDOW_MS + 31_000 }).allowed).toBe(true);
  });

  it("holds a slot while the request runs and frees it when it is done", () => {
    const limits = { maxConcurrent: 1 };
    expect(checkKeyRateLimit(KEY, limits).allowed).toBe(true);

    const blocked = checkKeyRateLimit(KEY, limits);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("maxConcurrent");

    finishKeyRequest(KEY, 0);
    expect(checkKeyRateLimit(KEY, limits).allowed).toBe(true);
  });

  it("counts the tokens of the finished requests against the minute", () => {
    const now = 1_700_000_000_000;
    const limits = { tpm: 1000 };

    expect(checkKeyRateLimit(KEY, limits, { now }).allowed).toBe(true);
    finishKeyRequest(KEY, 600, { now });

    expect(checkKeyRateLimit(KEY, limits, { now: now + 10 }).allowed).toBe(true);
    finishKeyRequest(KEY, 600, { now: now + 10 });

    const blocked = checkKeyRateLimit(KEY, limits, { now: now + 20 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("tpm");
    expect(blocked.limit).toBe(1000);
  });

  it("counts the tokens of the day", () => {
    const now = 1_700_000_000_000;
    const limits = { dailyTokens: 500 };

    checkKeyRateLimit(KEY, limits, { now });
    finishKeyRequest(KEY, 500, { now });

    const blocked = checkKeyRateLimit(KEY, limits, { now: now + 10 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("dailyTokens");

    // A new day starts with an empty budget.
    expect(checkKeyRateLimit(KEY, limits, { now: now + DAY_MS + 1 }).allowed).toBe(true);
  });

  it("keeps the budgets of two keys apart", () => {
    const limits = { rpm: 1 };
    expect(checkKeyRateLimit("a", limits).allowed).toBe(true);
    expect(checkKeyRateLimit("b", limits).allowed).toBe(true);
    expect(checkKeyRateLimit("a", limits).allowed).toBe(false);
  });

  it("shows what a key used", () => {
    const now = 1_700_000_000_000;
    const limits = { rpm: 10, tpm: 1000, dailyTokens: 5000, maxConcurrent: 2 };
    checkKeyRateLimit(KEY, limits, { now });
    finishKeyRequest(KEY, 250, { now });

    const snapshot = keyLimitSnapshot(KEY, limits, { now });
    expect(snapshot.requestsThisMinute).toBe(1);
    expect(snapshot.tokensThisMinute).toBe(250);
    expect(snapshot.tokensToday).toBe(250);
    expect(snapshot.rpmRemaining).toBe(9);
    expect(snapshot.tpmRemaining).toBe(750);
    expect(snapshot.dailyRemaining).toBe(4750);
    expect(snapshot.concurrentRemaining).toBe(2);
  });

  it("forgets the counters on reset", () => {
    const limits = { rpm: 1 };
    checkKeyRateLimit(KEY, limits);
    expect(checkKeyRateLimit(KEY, limits).allowed).toBe(false);
    resetKeyLimits(KEY);
    expect(checkKeyRateLimit(KEY, limits).allowed).toBe(true);
  });
});
