// In-flight accounting for concurrent agents.
//
// Two separate jobs:
//   • admission control — how many upstream requests the router runs at once
//     (settings.routingPolicy.maxAgentsConcurrency, default 8). Beyond that a
//     request queues; it is never rejected, because a queue is slow and a
//     rejection is an error the client would see.
//   • per-connection load — which credential is least busy. Without this the
//     selector kept handing every request the same connection (fill-first), so
//     eight parallel agents landed on one account and upstream answered with
//     "too many parallel requests" / timeouts.
//
// A slot is held from dispatch until the upstream answers with headers (the
// window where a stampede of agents collides), not until the stream drains.

const connectionLoads = new Map();
let active = 0;
const waiters = [];

export function beginConnection(connectionId) {
  if (!connectionId) return () => {};
  connectionLoads.set(connectionId, (connectionLoads.get(connectionId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (connectionLoads.get(connectionId) || 1) - 1;
    if (next <= 0) connectionLoads.delete(connectionId);
    else connectionLoads.set(connectionId, next);
  };
}

export function connectionLoad(connectionId) {
  return connectionLoads.get(connectionId) || 0;
}

/**
 * Order candidate connections by how busy they are (idle first), keeping the
 * stored priority as the tie-breaker so an explicit ranking still wins.
 * @param {Array<{id?:string}>} connections
 * @param {number} cap - max concurrent requests one connection may carry
 * @returns {Array<{id?:string}>} sorted, headroom-capable connections first
 */
export function rankByLoad(connections, cap = 1) {
  const list = Array.isArray(connections) ? connections : [];
  const scored = list.map((connection, index) => ({
    connection,
    index,
    load: connectionLoad(connection?.id),
  }));
  scored.sort((a, b) => {
    const aHeadroom = a.load >= cap ? 1 : 0;
    const bHeadroom = b.load >= cap ? 1 : 0;
    if (aHeadroom !== bHeadroom) return aHeadroom - bHeadroom;
    if (a.load !== b.load) return a.load - b.load;
    return a.index - b.index;
  });
  return scored.map((entry) => entry.connection);
}

/**
 * Reserve one upstream slot.
 * @param {{maxAgentsConcurrency:number,admissionQueueMs:number}} policy
 * @returns {Promise<() => void>} release function (idempotent)
 */
export async function acquireSlot(policy) {
  const max = Math.max(1, Number(policy?.maxAgentsConcurrency) || 8);
  const queueMs = Math.max(0, Number(policy?.admissionQueueMs) ?? 20000);

  if (active < max) {
    active += 1;
    return makeRelease();
  }

  // Full: queue. On timeout we still serve (fail-open) — a late answer beats a
  // 503 the client would read as a failure.
  return await new Promise((resolve) => {
    let settled = false;
    const entry = () => {
      if (settled) return;
      settled = true;
      active += 1;
      resolve(makeRelease());
    };
    entry.resolve = entry;
    waiters.push(entry);
    if (queueMs > 0) {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        const at = waiters.indexOf(entry);
        if (at >= 0) waiters.splice(at, 1);
        // Serve out of order rather than failing.
        active += 1;
        resolve(makeRelease());
      }, queueMs);
    }
  });
}

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  };
}

export function snapshot() {
  return {
    active,
    connections: Object.fromEntries(connectionLoads.entries()),
  };
}

// Test/diagnostic hook: forget all counters (a crashed stream can leak a slot).
export function reset() {
  connectionLoads.clear();
  active = 0;
  waiters.length = 0;
}
