// Provider health.
//
// "Is this provider working right now?" - answered from the requests that
// went out (how many, how many failed, how fast they came back) and from the
// connections (is the credential parked, expired or locked).
//
// Pure functions on purpose: the rules are worth testing without a database,
// and the API route only has to read the rows and hand them over.
//
// Status rules, checked in this order:
//
//   down      The provider failed and never succeeded inside the window, AND
//             every connection of that provider reports an error or a lock.
//             Without connections there is nothing to be "down" about - the
//             provider is simply failing, which is "degraded".
//   degraded  The error rate is above 5%, OR at least one of the last 10
//             requests failed. A failure ten seconds ago says more about
//             "now" than one failed call out of a hundred an hour ago.
//   healthy   At least one request succeeded and the error rate is <= 5%.
//   idle      The provider is configured but was never used inside the window.
//   unknown   Nothing is known: no connection, no traffic.
//
// Latency comes from the caller - the request log is the only place that
// keeps how long a call took. The samples handed over here are averaged and
// reduced to a p95 (nearest rank); both stay null when there is no latency
// data at all.

export const HEALTHY = "healthy";
export const DEGRADED = "degraded";
export const DOWN = "down";
export const IDLE = "idle";
export const UNKNOWN = "unknown";

// Worst first - that is the order the dashboard shows them in.
export const HEALTH_STATUSES = [DOWN, DEGRADED, HEALTHY, IDLE, UNKNOWN];

// A provider is degraded once more than one in twenty requests fails.
export const DEGRADED_ERROR_RATE = 0.05;
// How many of the most recent requests are looked at for a fresh failure.
export const RECENT_REQUEST_COUNT = 10;

const MODEL_LOCK_PREFIX = "modelLock_";

const OK_STATUSES = new Set(["ok", "success", "succeeded", "done", "completed", "passed"]);
// testStatus of a connection that is known to be broken. "active" is the good
// one, "unavailable" is what the auth layer writes after a failed call.
const FAILED_TEST_STATUSES = new Set([
  "unavailable", "error", "failed", "invalid", "expired", "revoked", "broken",
]);

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function toTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * A row is an error unless it says it was fine. The request ledger writes
 * "ok", the request log writes "success" or "error" - and both are accepted.
 */
export function isErrorStatus(status) {
  if (status === null || status === undefined) return false;
  const text = String(status).trim().toLowerCase();
  if (!text) return false;
  if (OK_STATUSES.has(text)) return false;
  if (/^2\d\d\b/.test(text)) return false; // "200", "200 OK"
  return true;
}

/**
 * The error text of a connection or a failed row. Connections store it as a
 * plain string or as { message, status, timestamp }; rows carry a message.
 */
function readErrorText(value) {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "object") {
    const text = value.message || value.errorText || value.error || value.reason;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

function readRowError(row) {
  return readErrorText(row.error) || readErrorText(row.errorMessage) || readErrorText(row.message);
}

/**
 * Latency of one row: either a flat number or the { ttft, total } the request
 * log keeps. Only positive samples count - a 0 ms call is a missing value.
 */
function readRowLatency(row) {
  const direct = toNumber(row.latencyMs);
  if (direct !== null) return direct;
  const latency = row.latency;
  if (latency && typeof latency === "object") {
    return toNumber(latency.total ?? latency.durationMs ?? latency.ms);
  }
  return toNumber(latency);
}

/**
 * Earliest expiry of a still active model lock on a connection
 * (modelLock_<model> / modelLock___all).
 */
function activeModelLockUntil(connection, now) {
  let earliest = null;
  for (const [key, value] of Object.entries(connection || {})) {
    if (!key.startsWith(MODEL_LOCK_PREFIX)) continue;
    const until = toTime(value);
    if (until === null || until <= now) continue;
    if (earliest === null || until < earliest) earliest = until;
  }
  return earliest;
}

/**
 * The state of one connection: "ok", "error" (the credential itself is
 * broken) or "locked" (it is parked - rate limited, in backoff, or a model
 * is locked on it).
 */
export function readConnectionState(connection, now = Date.now()) {
  const error = readErrorText(connection?.lastError);
  const lockUntil = activeModelLockUntil(connection, now);
  const rateLimitedUntil = toTime(connection?.rateLimitedUntil);
  const rateLimited = rateLimitedUntil !== null && rateLimitedUntil > now;
  const backoffLevel = toNumber(connection?.backoffLevel) || 0;
  const testStatus = connection?.testStatus ? String(connection.testStatus).toLowerCase() : null;
  const testFailed = testStatus ? FAILED_TEST_STATUSES.has(testStatus) : false;

  const locked = lockUntil !== null || rateLimited || backoffLevel > 0;
  const failed = Boolean(error) || testFailed;

  return {
    status: failed ? "error" : locked ? "locked" : "ok",
    error,
    locked,
    lockUntil,
    rateLimitedUntil,
    backoffLevel,
    testStatus,
  };
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.min(sortedValues.length - 1, Math.max(0, rank - 1));
  return sortedValues[index];
}

function bySeverity(a, b) {
  const diff = HEALTH_STATUSES.indexOf(a.status) - HEALTH_STATUSES.indexOf(b.status);
  if (diff !== 0) return diff;
  if (b.requests !== a.requests) return b.requests - a.requests;
  return a.name.localeCompare(b.name);
}

/**
 * Turn connections + request events into one health entry per provider.
 *
 * @param {Array} connections  provider connections (provider, testStatus,
 *                             lastError, backoffLevel, modelLock_* ...)
 * @param {Array} usageRows    request events inside the window
 *                             ({ provider, status, timestamp, latencyMs? })
 * @param {object} [options]
 * @param {Record<string, number[]>} [options.latencies] latency samples (ms)
 *                             per provider
 * @param {Record<string, string>} [options.names] display name per provider
 * @param {string[]} [options.providers] provider ids to list even when there
 *                             is no connection and no traffic (they show up
 *                             as "unknown")
 * @param {Date} [options.now] clock used for lock expiry
 * @param {number} [options.degradedErrorRate] error rate that means degraded
 * @param {number} [options.recentRequests] how many recent requests are
 *                             checked for a fresh failure
 */
export function buildProviderHealth(connections, usageRows, options = {}) {
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const degradedErrorRate = options.degradedErrorRate ?? DEGRADED_ERROR_RATE;
  const recentRequestCount = options.recentRequests ?? RECENT_REQUEST_COUNT;
  const latencies = options.latencies || {};
  const names = options.names || {};

  const connList = Array.isArray(connections) ? connections : [];
  const rowList = Array.isArray(usageRows) ? usageRows : [];

  const connectionsByProvider = new Map();
  for (const connection of connList) {
    const provider = connection?.provider;
    if (!provider) continue;
    if (!connectionsByProvider.has(provider)) connectionsByProvider.set(provider, []);
    connectionsByProvider.get(provider).push(connection);
  }

  const rowsByProvider = new Map();
  for (const row of rowList) {
    const provider = row?.provider || "unknown";
    if (!rowsByProvider.has(provider)) rowsByProvider.set(provider, []);
    rowsByProvider.get(provider).push(row);
  }

  const providerIds = new Set([...connectionsByProvider.keys(), ...rowsByProvider.keys()]);
  for (const provider of options.providers || []) {
    if (provider) providerIds.add(provider);
  }

  const health = [];

  for (const provider of providerIds) {
    const providerConnections = connectionsByProvider.get(provider) || [];
    const providerRows = rowsByProvider.get(provider) || [];

    // Newest first. Rows without a timestamp sort last - they are the oldest
    // thing we know about, not the freshest.
    const orderedRows = [...providerRows].sort((a, b) => {
      const aTime = toTime(a?.timestamp) ?? -Infinity;
      const bTime = toTime(b?.timestamp) ?? -Infinity;
      return bTime - aTime;
    });

    const requests = providerRows.length;
    let errors = 0;
    let lastUsedAt = null;
    let lastUsedTime = -Infinity;
    // Every error we know about, with the time it happened. The newest one is
    // the one worth showing.
    const errorCandidates = [];

    for (const row of providerRows) {
      const rowTime = toTime(row?.timestamp);
      if (rowTime !== null && rowTime > lastUsedTime) {
        lastUsedTime = rowTime;
        lastUsedAt = row.timestamp;
      }
      if (!isErrorStatus(row?.status)) continue;
      errors += 1;
      const message = readRowError(row);
      if (message) errorCandidates.push({ message, time: rowTime ?? -Infinity });
    }

    const connectionStates = providerConnections.map((connection) => ({
      connection,
      state: readConnectionState(connection, now),
    }));

    for (const { connection, state } of connectionStates) {
      if (!state.error) continue;
      errorCandidates.push({
        message: state.error,
        time: toTime(connection?.lastErrorAt) ?? -Infinity,
      });
    }

    const newestError = errorCandidates.reduce(
      (best, candidate) => (candidate.time > best.time ? candidate : best),
      { message: null, time: -Infinity },
    );
    const lastError = newestError.message;

    const errorRate = requests > 0 ? Math.round((errors / requests) * 10000) / 10000 : 0;
    const recentRows = orderedRows.slice(0, recentRequestCount);
    const recentFailure = recentRows.some((row) => isErrorStatus(row?.status));

    // Latency samples: the ones the caller collected plus the ones the rows
    // carry themselves.
    const samples = [];
    for (const row of providerRows) {
      const latency = readRowLatency(row);
      if (latency !== null && latency > 0) samples.push(latency);
    }
    for (const sample of latencies[provider] || []) {
      const latency = toNumber(sample);
      if (latency !== null && latency > 0) samples.push(latency);
    }
    const sortedSamples = [...samples].sort((a, b) => a - b);
    const avgLatencyMs = sortedSamples.length
      ? Math.round(sortedSamples.reduce((sum, value) => sum + value, 0) / sortedSamples.length)
      : null;
    const p95LatencyMs = percentile(sortedSamples, 95);

    const successes = requests - errors;
    const allConnectionsFailing =
      providerConnections.length > 0 &&
      connectionStates.every(({ state }) => state.status !== "ok");

    let status;
    if (requests === 0) {
      // Configured but untouched inside the window - or nothing at all.
      status = providerConnections.length > 0 ? IDLE : UNKNOWN;
    } else if (errors > 0 && successes === 0 && allConnectionsFailing) {
      status = DOWN;
    } else if (errorRate > degradedErrorRate || recentFailure) {
      status = DEGRADED;
    } else if (successes > 0) {
      status = HEALTHY;
    } else {
      status = UNKNOWN;
    }

    health.push({
      provider,
      name: names[provider] || provider,
      status,
      requests,
      errors,
      errorRate,
      avgLatencyMs,
      p95LatencyMs,
      lastUsedAt: lastUsedAt || null,
      lastError,
      connections: connectionStates.map(({ connection, state }) => ({
        id: connection.id,
        name: connection.name || connection.email || connection.id,
        isActive: connection.isActive !== false,
        status: state.status,
        testStatus: state.testStatus,
        backoffLevel: state.backoffLevel,
        lastError: state.error,
      })),
    });
  }

  return health.sort(bySeverity);
}

/**
 * How many providers sit in each state.
 *
 * @param {Array} list entries built by buildProviderHealth
 */
export function summarizeHealth(list) {
  const summary = { healthy: 0, degraded: 0, down: 0, idle: 0, unknown: 0, total: 0 };
  for (const entry of Array.isArray(list) ? list : []) {
    const status = entry?.status;
    if (status && Object.hasOwn(summary, status)) summary[status] += 1;
    summary.total += 1;
  }
  return summary;
}
