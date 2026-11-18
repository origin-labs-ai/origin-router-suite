/**
 * Seat health — the small, in-memory gate that stops a slow or dead pool
 * member from being re-picked on the next request.
 *
 * The Provider Adapter Harness knows how to speak each wire format; this file
 * knows how a seat behaved. A single timeout or transport error cools a seat
 * for 90 seconds. A success clears it immediately. The store is intentionally
 * tiny and process-local: it is a routing hint, not durable telemetry.
 */

const COOLDOWN_MS = 90_000;
const seats = new Map();

export function isSeatHealthy(model) {
  if (!model) return false;
  const entry = seats.get(model);
  if (!entry) return true;
  if (entry.cooldownUntil > Date.now()) return false;
  seats.delete(model);
  return true;
}

export function markSeatSuccess(model) {
  if (model) seats.delete(model);
}

export function markSeatFailure(model, reason = "failure", cooldownMs = COOLDOWN_MS) {
  if (!model) return;
  const previous = seats.get(model);
  seats.set(model, {
    failures: (previous?.failures || 0) + 1,
    cooldownUntil: Date.now() + Math.max(COOLDOWN_MS, Number(cooldownMs) || 0),
    reason: String(reason).slice(0, 120),
    at: new Date().toISOString(),
  });
}

export function seatHealthSnapshot() {
  const now = Date.now();
  return [...seats.entries()]
    .map(([model, entry]) => ({
      model,
      failures: entry.failures,
      healthy: entry.cooldownUntil <= now,
      cooldownMs: Math.max(0, entry.cooldownUntil - now),
      reason: entry.reason,
      at: entry.at,
    }))
    .sort((a, b) => b.failures - a.failures);
}

export function resetSeatHealth() {
  seats.clear();
}
