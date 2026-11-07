// Combo seat orderers — the engine-side half of the routing strategy registry
// (src/lib/routing/strategies.js lists all 24; this file implements the
// orderer/brain-family ordering. Fusion/pipeline dispatch live in combo.js).
//
// Design rules, inherited from the house style:
//   - Fail open. A missing data source (no quota snapshot source, no pricing,
//     no stats) must reorder to the declaration order rather than error the
//     request. A strategy that cannot compute its preference is a preference,
//     not a dependency.
//   - State is in-memory, bounded, per-combo — the same trade the existing
//     rotation state already makes.
//   - Every orderer returns a permutation of the seat list, never a subset —
//     the fallback walk behind it must still be able to try every seat.

import { getPricingForModel } from "../providers/pricing.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";

// ─── Shared seat statistics ───────────────────────────────────────────────────

const SEAT_STATS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const COMBO_BUCKETS_CAP = 256;

const seatStats = new Map(); // comboName → Map(modelStr → stats)

function statsBucket(comboName) {
  let bucket = seatStats.get(comboName) || null;
  if (bucket) return bucket;
  if (seatStats.size >= COMBO_BUCKETS_CAP) {
    const oldest = seatStats.keys().next().value;
    if (oldest !== undefined) seatStats.delete(oldest);
  }
  bucket = new Map();
  seatStats.set(comboName, bucket);
  return bucket;
}

function getSeatStat(comboName, modelStr) {
  return seatStats.get(comboName || "__default__")?.get(modelStr) || null;
}

export function recordSeatOutcome(modelStr, { comboName = "__default__", ok = false, status = 0, firstByteMs = 0, errorKind = "" } = {}) {
  const now = Date.now();
  const bucket = statsBucket(comboName || "__default__");
  let s = bucket.get(modelStr);
  if (!s) {
    s = {
      picks: 0,
      ok: 0,
      fail: 0,
      lastOkAt: 0,
      lastFailAt: 0,
      lastStatus: 0,
      lastErrorKind: "",
      firstByteMsSum: 0,
      firstByteN: 0,
      lastPickedAt: 0,
    };
    bucket.set(modelStr, s);
  }
  s.picks += 1;
  s.lastPickedAt = now;
  if (ok) {
    s.ok += 1;
    s.lastOkAt = now;
  } else {
    s.fail += 1;
    s.lastFailAt = now;
  }
  if (status) s.lastStatus = status;
  if (errorKind) s.lastErrorKind = String(errorKind).slice(0, 64);
  if (firstByteMs > 0) {
    s.firstByteMsSum += firstByteMs;
    s.firstByteN += 1;
  }
  if (bucket.size > 64) {
    for (const [key, stat] of bucket) {
      if (now - stat.lastPickedAt > SEAT_STATS_TTL_MS) bucket.delete(key);
    }
  }
  return s;
}

function seatHealth(s) {
  if (!s || (s.ok + s.fail) === 0) return 1;
  return s.ok / (s.ok + s.fail);
}

function seatAvgFirstByteMs(s) {
  if (!s || s.firstByteN === 0) return null;
  return s.firstByteMsSum / s.firstByteN;
}

// ─── Parsing & misc helpers ──────────────────────────────────────────────────

function splitModel(modelStr) {
  const s = String(modelStr || "");
  const idx = s.indexOf("/");
  if (idx <= 0) return { provider: "", model: s };
  return { provider: s.slice(0, idx), model: s.slice(idx + 1) };
}

function fisherYates(models) {
  const order = [...models];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function stableSortBy(models, scoreFn) {
  return models
    .map((m, i) => ({ m, i, score: scoreFn(m) }))
    .sort((a, b) => (a.score - b.score) || (a.i - b.i))
    .map((x) => x.m);
}

function prepend(models, head) {
  if (!models.includes(head)) return [...models];
  return [head, ...models.filter((m) => m !== head)];
}

const stateMaps = new Map(); // name → comboName → Map(modelStr/key → entry)
function boundedState(name, comboName) {
  let m = stateMaps.get(name);
  if (!m) {
    m = new Map();
    stateMaps.set(name, m);
  }
  let perCombo = m.get(comboName);
  if (!perCombo) {
    if (m.size >= COMBO_BUCKETS_CAP) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
    perCombo = new Map();
    m.set(comboName, perCombo);
  }
  return perCombo;
}

// ─── Individual orderers ─────────────────────────────────────────────────────

// Strict random: deck draw. Each seat is used once before the deck reshuffles,
// so the spread is guaranteed rather than probabilistic.
function orderStrictRandom(models, comboName) {
  const decks = boundedState("strictRandom", comboName || "__default__");
  let deck = decks.get("__deck__");
  if (!Array.isArray(deck) || deck.length === 0 || !deck.every((m) => models.includes(m))) {
    deck = fisherYates(models);
  }
  const head = deck.shift();
  decks.set("__deck__", deck);
  return prepend(models, head);
}

// Weighted: distribute traffic by per-seat weight percentages
// (comboStrategies[name].weights = { [modelStr]: number }). Weights are
// relative; the head seat is drawn proportionally, everything else follows.
function orderWeighted(models, comboName, weights = {}) {
  const entries = models.map((m) => ({ m, w: Math.max(0, Number(weights[m]) || 0) }));
  const total = entries.reduce((sum, e) => sum + e.w, 0);
  if (!(total > 0)) return models;
  let roll = Math.random() * total;
  for (const e of entries) {
    roll -= e.w;
    if (roll <= 0) return prepend(models, e.m);
  }
  return models;
}

// Fill first: lock onto the first healthy seat and only move when it fails.
// A dead seat is re-probed after a cooldown so recovery is noticed.
const FILL_FIRST_RETRY_MS = 5 * 60 * 1000;
function orderFillFirst(models, comboName) {
  const combo = comboName || "__default__";
  const state = boundedState("fillFirst", combo);
  const now = Date.now();
  const locked = state.get("__locked__");
  if (locked && models.includes(locked)) {
    const s = getSeatStat(combo, locked);
    const recentlyFailed = s && now - s.lastFailAt < FILL_FIRST_RETRY_MS && s.lastFailAt > s.lastOkAt;
    if (!recentlyFailed) return prepend(models, locked);
  }
  const next = models.find((m) => seatHealth(getSeatStat(combo, m)) >= 0.5) || models[0];
  state.set("__locked__", next);
  return prepend(models, next);
}

// Power of two choices: pick two random seats, prefer the healthier (and, on
// ties, the faster) one. Uniform enough to spread load, smart enough to dodge
// seats that are actively failing.
function orderP2C(models, comboName) {
  if (models.length < 2) return models;
  const a = Math.floor(Math.random() * models.length);
  let b = Math.floor(Math.random() * models.length);
  if (b === a) b = (b + 1) % models.length;
  const combo = comboName || "__default__";
  const sa = getSeatStat(combo, models[a]);
  const sb = getSeatStat(combo, models[b]);
  const score = (s) => {
    const speedPenalty = s && s.firstByteN > 0 ? Math.min(s.firstByteMsSum / s.firstByteN / 30000, 1) : 0;
    return seatHealth(s) * 2 - speedPenalty;
  };
  const winner = score(sa) >= score(sb) ? models[a] : models[b];
  return prepend(models, winner);
}

// Least used: fewest picks first over the rolling stats window, breaking ties
// by declaration order (stable sort).
function orderLeastUsed(models, comboName) {
  const combo = comboName || "__default__";
  return stableSortBy(models, (m) => getSeatStat(combo, m)?.picks || 0);
}

// Last known good: the seat that last completed a request successfully goes
// first. Unknown seats keep the declaration order behind it.
function orderLKGP(models, comboName) {
  const combo = comboName || "__default__";
  let best = null;
  let bestAt = 0;
  for (const m of models) {
    const s = getSeatStat(combo, m);
    if (s && s.lastOkAt > bestAt) {
      bestAt = s.lastOkAt;
      best = m;
    }
  }
  return best ? prepend(models, best) : models;
}

// ─── Cost / context / cache orderers ─────────────────────────────────────────
// NOTE: every Math.random in this file is load-balancing randomness (shuffle,
// proportional draw, p2c sampling) — none of it is a cryptographic primitive.

// Cost optimized: cheapest input price first, using the same pricing table the
// cost dashboard reads. Models without pricing data keep their relative order.
function orderCostOptimized(models) {
  const inputCost = (m) => {
    try {
      const { provider, model } = splitModel(m);
      const p = getPricingForModel(provider, model);
      return Number(p?.input) || 0; // per-token input price, 0 = free/unknown
    } catch {
      return 0;
    }
  };
  return stableSortBy(models, inputCost);
}

// Context optimized: largest usable context window first, so long
// conversations land on the seats that can actually hold them.
function orderContextOptimized(models) {
  const ctx = (m) => {
    try {
      const { provider, model } = splitModel(m);
      const caps = getCapabilitiesForModel(provider, model);
      return Number(caps?.contextWindow) || 0;
    } catch {
      return 0;
    }
  };
  return stableSortBy(models, (m) => -ctx(m));
}

// Prompt-prefix cache affinity: hash the stable head of the conversation
// (system + first messages) to pick a seat, then keep that mapping. Same
// reusable prefix consistently lands on the same seat, which keeps the
// upstream prompt cache warm and the input bill low.
const PREFIX_AFFINITY_WINDOW_MS = 10 * 60 * 1000;

function promptPrefixKey(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const head = [];
  for (const msg of messages) {
    if (head.length >= 4) break;
    const role = String(msg?.role || "");
    const text = typeof msg?.content === "string"
      ? msg.content
      : Array.isArray(msg?.content)
        ? msg.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ")
        : "";
    head.push(`${role}:${text.slice(0, 512)}`);
  }
  let h = 5381;
  const input = head.join("\u0000");
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

function orderCacheOptimized(models, comboName, body) {
  const combo = comboName || "__default__";
  const key = promptPrefixKey(body);
  const state = boundedState("cacheAffinity", combo);
  const now = Date.now();
  const existing = state.get(key);
  if (existing && models.includes(existing.model) && now - existing.at < PREFIX_AFFINITY_WINDOW_MS) {
    existing.at = now;
    return prepend(models, existing.model);
  }
  const head = models[Math.floor(Math.random() * models.length)];
  state.set(key, { model: head, at: now });
  return prepend(models, head);
}

// ─── Quota family ────────────────────────────────────────────────────────────
// A quota snapshot source can be wired at startup (the quota dashboard reads
// the same thing). Shape: (comboName) => Map(modelStr → { remaining (0-1),
// resetsAt (epoch ms) | null }). Without a source — or for seats it does not
// know — the family fails open to fairness rotation: least-recently-picked
// first, which spreads load across reset windows almost as well.

let quotaSource = null;

export function setQuotaSource(fn) {
  quotaSource = typeof fn === "function" ? fn : null;
}

function fairnessRotation(models, comboName) {
  const combo = comboName || "__default__";
  return stableSortBy(models, (m) => getSeatStat(combo, m)?.lastPickedAt || 0);
}

function quotaEntries(models, snapshot) {
  return models.map((m) => {
    const q = snapshot instanceof Map ? snapshot.get(m) : snapshot?.[m];
    const remaining = q && Number.isFinite(Number(q.remaining)) ? Math.min(1, Math.max(0, Number(q.remaining))) : null;
    const resetsAt = q && Number.isFinite(Number(q.resetsAt)) ? Number(q.resetsAt) : null;
    return { m, remaining, resetsAt };
  });
}

function orderQuota(models, comboName, { mode = "headroom" } = {}) {
  const combo = comboName || "__default__";
  let snapshot = null;
  try {
    snapshot = quotaSource ? quotaSource(combo) : null;
  } catch {
    snapshot = null;
  }
  if (!snapshot) return fairnessRotation(models, combo);

  const entries = quotaEntries(models, snapshot).map((e) => ({
    ...e,
    remaining: e.remaining ?? 1,
    resetsAt: e.resetsAt ?? 0,
  }));

  if (mode === "expiry-first") {
    // Soonest-expiring quota first so nothing is wasted. Seats with no reset
    // info are treated as never expiring and go last.
    const withReset = entries.filter((e) => e.resetsAt > 0);
    if (withReset.length === 0) return fairnessRotation(models, combo);
    withReset.sort((a, b) => a.resetsAt - b.resetsAt);
    const rest = entries.filter((e) => !(e.resetsAt > 0));
    return [...withReset, ...rest].map((e) => e.m);
  }

  if (mode === "reset-window" || mode === "reset-aware") {
    // Group by coarse reset bucket, freshest group first. reset-aware
    // additionally prefers seats with more remaining quota inside the bucket.
    const now = Date.now();
    const bucketOf = (e) => {
      if (!(e.resetsAt > 0)) return Number.MAX_SAFE_INTEGER;
      const hours = Math.max(0, e.resetsAt - now) / 3_600_000;
      return Math.min(24, Math.floor(hours / 4)); // 4-hour buckets
    };
    const sorted = entries
      .map((e) => ({ ...e, bucket: bucketOf(e) }))
      .sort((a, b) => (a.bucket - b.bucket) || (mode === "reset-aware" ? b.remaining - a.remaining : 0));
    return sorted.map((e) => e.m);
  }

  if (mode === "quota-weighted") {
    // Draw proportionally to leftover quota; exhausted seats sink.
    const total = entries.reduce((sum, e) => sum + Math.max(e.remaining, 0.001), 0);
    let roll = Math.random() * total;
    for (const e of entries) {
      roll -= Math.max(e.remaining, 0.001);
      if (roll <= 0) return prepend(models, e.m);
    }
    return models;
  }

  // headroom (default): most remaining quota first.
  const sorted = [...entries].sort((a, b) => b.remaining - a.remaining);
  return sorted.map((e) => e.m);
}

// ─── Arbitrage family ────────────────────────────────────────────────────────

// Latency arbitrage (Smart Latency & Token Arbitrage): score every seat on
// real-time cost × speed × health and send the work where the value is. Light
// tasks lean on cost, heavy tasks on speed and health — the situation adjusts
// the weights, not the operator.
function orderLatencyArbitrage(models, comboName, body) {
  const combo = comboName || "__default__";
  const promptChars = Array.isArray(body?.messages)
    ? body.messages.reduce((n, m) => n + (typeof m?.content === "string" ? m.content.length : 0), 0)
    : 0;
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const taskWeight = Math.min(1, (hasTools ? 0.35 : 0) + Math.min(promptChars / 60_000, 0.65));

  const scored = models.map((m) => {
    const s = getSeatStat(combo, m);
    const health = seatHealth(s);
    const rawAvg = seatAvgFirstByteMs(s);
    const avgMs = rawAvg == null ? 5000 : rawAvg; // unknown → neutral middle
    const { provider, model } = splitModel(m);
    let cost = 0;
    try {
      const p = getPricingForModel(provider, model);
      cost = Number(p?.input) || 0;
    } catch {
      cost = 0;
    }
    // Normalise: speed 0..1 (faster better), cheapness 0..1 (cheaper better).
    const speed = Math.max(0, Math.min(1, 1 - avgMs / 30_000));
    const cheap = Math.max(0, Math.min(1, 1 - Math.min(cost / 0.00001, 1)));
    // Health always matters; cost matters more for light tasks, speed for heavy.
    const score = health * 1.5 + cheap * (1.2 - 0.7 * taskWeight) + speed * (0.6 + 0.7 * taskWeight);
    return { m, score, at: s?.lastPickedAt || 0 };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.at - b.at));
  return scored.map((x) => x.m);
}

// Shadow cache: prefix affinity plus the local encrypted shadow cache (see
// open-sse/services/shadowCache.js). The cache answers repeat prefixes without
// an upstream call; the orderer keeps the affinity so the upstream prefix
// cache stays warm too. The response-cache lookup itself happens in the chat
// handler before any seat is tried.
function orderShadowCache(models, comboName, body) {
  return orderCacheOptimized(models, comboName, body);
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

// Shared circuit breaker: a seat that just failed repeatedly for the same
// combo is demoted to the back of the order for a cooldown window, so every
// concurrent request does not re-walk a dying seat. Demotion, never removal —
// the fallback walk behind it can still reach every seat.
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60 * 1000;

function demoteCircuitOpenSeats(models, comboName) {
  const combo = comboName || "__default__";
  const now = Date.now();
  const healthy = [];
  const demoted = [];
  for (const m of models) {
    const s = getSeatStat(combo, m);
    const recentFails = s && s.fail >= CIRCUIT_FAIL_THRESHOLD && now - s.lastFailAt < CIRCUIT_COOLDOWN_MS && s.lastFailAt > s.lastOkAt;
    (recentFails ? demoted : healthy).push(m);
  }
  return [...healthy, ...demoted];
}

export function orderSeats(models, strategy, ctx = {}) {
  const { comboName = "__default__", body = {}, weights = {} } = ctx;
  if (!Array.isArray(models) || models.length <= 1) return models;
  const ordered = orderSeatsInner(models, strategy, ctx);
  // The declaration order is sacred for "fallback" — the owner's manual seat
  // order means something, so the circuit breaker never reorders it. Health
  // strategies reorder anyway; only they get the demotion pass.
  if (strategy === "fallback") return ordered;
  return demoteCircuitOpenSeats(ordered, comboName);
}

function orderSeatsInner(models, strategy, ctx) {
  const { comboName = "__default__", body = {}, weights = {} } = ctx;
  switch (strategy) {
    case "strict-random": return orderStrictRandom(models, comboName);
    case "weighted": return orderWeighted(models, comboName, weights);
    case "fill-first": return orderFillFirst(models, comboName);
    case "p2c": return orderP2C(models, comboName);
    case "least-used": return orderLeastUsed(models, comboName);
    case "lkgp": return orderLKGP(models, comboName);
    case "cost-optimized": return orderCostOptimized(models);
    case "context-optimized": return orderContextOptimized(models);
    case "cache-optimized": return orderCacheOptimized(models, comboName, body);
    case "shadow-cache": return orderShadowCache(models, comboName, body);
    case "reset-aware": return orderQuota(models, comboName, { mode: "reset-aware" });
    case "reset-window": return orderQuota(models, comboName, { mode: "reset-window" });
    case "headroom": return orderQuota(models, comboName, { mode: "headroom" });
    case "quota-weighted": return orderQuota(models, comboName, { mode: "quota-weighted" });
    case "expiry-first": return orderQuota(models, comboName, { mode: "expiry-first" });
    case "latency-arbitrage": return orderLatencyArbitrage(models, comboName, body);
    // fallback / random / round-robin / smart / auto / autoaggressive /
    // fusion / pipeline are handled by the existing combo.js paths (rotation,
    // brain, panel) — the dispatcher is only consulted for the rest.
    default: return models;
  }
}

export function recordComboOutcome(modelStr, ctx = {}, outcome = {}) {
  return recordSeatOutcome(modelStr, {
    comboName: ctx.comboName || "__default__",
    ok: outcome.ok === true,
    status: outcome.status || 0,
    firstByteMs: outcome.firstByteMs || 0,
    errorKind: outcome.errorKind || "",
  });
}

export function getSeatStatsSnapshot(comboName) {
  const bucket = seatStats.get(comboName || "__default__");
  if (!bucket) return {};
  const out = {};
  for (const [modelStr, s] of bucket) {
    out[modelStr] = {
      picks: s.picks,
      ok: s.ok,
      fail: s.fail,
      health: seatHealth(s),
      avgFirstByteMs: s.firstByteN > 0 ? Math.round(s.firstByteMsSum / s.firstByteN) : null,
      lastOkAt: s.lastOkAt || null,
      lastFailAt: s.lastFailAt || null,
      lastStatus: s.lastStatus || null,
      lastErrorKind: s.lastErrorKind || null,
    };
  }
  return out;
}
