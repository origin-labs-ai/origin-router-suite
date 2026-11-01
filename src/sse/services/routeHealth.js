// Shared route health — the memory that a seat just refused a request.
//
// Without this, every concurrent agent walks the same list from the same top
// entry: eight requests, eight full sweeps, the same broken seat hammered eight
// times in one second, and the whole model list retried over and over. A failure
// seen by one request is evidence for all of them, so it is recorded once here
// and honoured for a short window (policy.degradeCooldownMs).
//
// Ordering also rotates its starting point per call, so a fleet spreads across
// the list instead of stampeding the first candidate.

const degraded = new Map();
let cursor = 0;

function now() {
  return Date.now();
}

export function isDegraded(route, at = now()) {
  const entry = degraded.get(route);
  if (!entry) return false;
  if (entry.until <= at) {
    degraded.delete(route);
    return false;
  }
  return true;
}

/**
 * Remember that a route just failed, with a growing cooldown while it keeps
 * failing (so a permanently dead seat stops eating attempts every request).
 */
export function markDegraded(route, { status = 0, error = "", cooldownMs = 45000 } = {}) {
  if (!route || cooldownMs <= 0) return;
  const previous = degraded.get(route);
  const strikes = (previous?.strikes || 0) + 1;
  const window = Math.min(cooldownMs * 2 ** Math.min(strikes - 1, 4), 15 * 60 * 1000);
  degraded.set(route, { until: now() + window, strikes, status, error: String(error || "").slice(0, 200) });
}

// A route that served a request is healthy again for everyone.
export function clearRoute(route) {
  degraded.delete(route);
}

export function strikeCount(route) {
  return degraded.get(route)?.strikes || 0;
}

/**
 * Order candidates: rotating start, degraded seats last.
 * @param {Array} items
 * @param {(item) => string} keyOf
 * @param {number} cooldownMs - kept only for the caller's log line
 * @returns {Array}
 */
export function orderRoutes(items, keyOf = (item) => item?.route, _cooldownMs = 0) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 2) return [...list];

  const offset = cursor++ % list.length;
  const rotated = [...list.slice(offset), ...list.slice(0, offset)];
  const fresh = rotated.filter((item) => !isDegraded(keyOf(item)));
  const degradedList = rotated.filter((item) => isDegraded(keyOf(item)));
  // Everything is degraded: still try, cheapest-strike-first, rather than
  // refusing — refusing is what the client must never see.
  return [...fresh, ...degradedList.sort((a, b) => strikeCount(keyOf(a)) - strikeCount(keyOf(b)))];
}

export function snapshot() {
  const at = now();
  const out = {};
  for (const [route, entry] of degraded.entries()) {
    if (entry.until > at) out[route] = { strikes: entry.strikes, status: entry.status, until: new Date(entry.until).toISOString() };
  }
  return out;
}

export function reset() {
  degraded.clear();
  cursor = 0;
}
