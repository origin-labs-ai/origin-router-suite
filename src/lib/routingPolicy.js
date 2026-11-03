// Routing resilience policy — the single place that decides how the router
// behaves when an upstream provider fails.
//
// Two guarantees the owner asked for:
//   1. N concurrent agents must be servable (default 8). Requests fan out over
//      connections instead of piling onto one credential, and excess requests
//      queue briefly rather than answering "too many parallel requests".
//   2. The client never sees an upstream API error. 400/401/402/403/404/429/5xx
//      and timeouts are internal signals used to rotate to another
//      provider/account; the caller only ever receives a response.
//
// Every value below is operator-tunable: Settings → Routing resilience
// (persisted as `settings.routingPolicy`) or the matching OR_* env var.

// The one timeout budget for the whole project: 7200s = 2 hours. Outbound calls,
// stream budgets and the failover walk all derive from here, because the owner's
// rule is "a slow answer is fine, a stall or a timeout is not".
export const GLOBAL_TIMEOUT_MS = 7_200_000;

export const ROUTER_BRAIN_MODES = ["panda", "jev", "merged"];

export const DEFAULT_ROUTING_POLICY = {
  // Master switch. false = old behaviour (surface upstream errors verbatim).
  enabled: true,
  // ─── Router brain: who decides which combo seat carries the task ───
  //   "panda"  → PandaOrchestrator only. Calibrated P(success) / cost / latency
  //              ranking of the seats; Jev is never called (no extra round-trip).
  //   "jev"    → System One (Jev) only. Semantic task classification picks the
  //              seat; the fallback tail is the owner's seat order + rotation.
  //   "merged" → both, in parallel, scores blended. Agreement is instant, a
  //              disagreement puts the loser brain's pick next in line as a hedge.
  // Every mode fails open: a brain that is down or silent never stops a request.
  routerBrain: "merged",
  // Blend weights for "merged". Normalised, so any positive pair works.
  jevWeight: 0.45,
  pandaWeight: 0.55,
  // How long the merged decision may take before whatever answered is used.
  // Bounded on purpose: the brains are advisory, the request is not.
  brainTimeoutMs: 3500,
  // Fairness term inside the blend. Without it every agent lands on the two or
  // three best-ranked seats and the rest of the combo never runs — the owner wants
  // both: best models used AND no seat left idle. 0 = pure merit, 1 = pure rotation.
  seatFairness: 0.3,
  // Window over which a seat's recent pick count is measured for that fairness term.
  seatFairnessWindowMs: 900000,
  // How much the model's class (Pro vs Flash) sways the blend. Panda reports the
  // task's difficulty; hard work leans toward the heavy end (Opus, Fable, Sol Pro,
  // GLM-5.3, Qwen-3.8-Max) and easy work toward the flash pool, so the good models
  // get used and the cheap pool absorbs volume instead of one quota draining dry.
  tierBias: 0.18,
  // Jev's own decision ceiling. Longer than one turn of Panda but far below the
  // global budget, so a stuck classifier cannot delay dispatch.
  jevTimeoutMs: 8000,
  // Concurrent upstream requests the router will serve at once.
  maxAgentsConcurrency: 8,
  // How many concurrent requests may share one credential before the selector
  // moves to the next connection. 1 = strict fan-out across accounts.
  perConnectionConcurrency: 2,
  // How long a request may wait for a free slot before it is served anyway.
  // Fail-open on purpose: a queued request is slow, a rejected one is an error.
  admissionQueueMs: 20000,
  // Rotate to other providers serving the same model when every account of the
  // requested provider failed.
  failoverEnabled: true,
  // Hedged start: a client that is still waiting for headers this long is
  // answered by a second seat tried in parallel, and the first answer wins.
  // Short agent traffic only (see hedgeMaxBytes), so a slow reasoning turn is
  // never duplicated — a classifier/safety call is exactly what must not time
  // out waiting behind a busy account.
  hedgeMs: 12000,
  // Only hedge requests whose payload is smaller than this (bytes).
  hedgeMaxBytes: 65536,
  // Cap on how many alternate provider routes one request may try.
  maxFailoverRoutes: 12,
  // Rest between fallback hops, jittered. Without it all eight agents walk the
  // fleet in lockstep and hammer the same seat in the same millisecond.
  hopBackoffMs: 250,
  // Hard budget for the whole failover walk; after it the last-resort policy
  // applies. Equal to the global budget: the walk is allowed to keep going until
  // a seat actually answers.
  failoverDeadlineMs: GLOBAL_TIMEOUT_MS,
  // An explicitly requested model stays on that model. The capability adapter may
  // not move a direct request ("I am testing THIS model") to a different model;
  // combos route freely. Turn off to restore adapter switching on solo requests.
  explicitModelSticky: true,
  // A route that just refused a request is skipped by every concurrent request
  // for this long. Without it, eight agents each walk the whole catalog from the
  // top, so every model gets hammered repeatedly in the same second and the
  // failing seat is retried over and over — that is the "sab upar se fallback",
  // "sab models par baar-baar" behaviour.
  degradeCooldownMs: 45000,
  // Never trim the prompt. A seat that cannot take the context is the wrong
  // seat; the answer is another seat, not a shortened conversation.
  trimOnPromptCap: false,
  // A stream that dies after HTTP 200 (stall, upstream reset, provider abort)
  // closes with a valid terminal frame instead of an error frame, so the caller
  // never receives an API error even mid-answer.
  midStreamSilent: true,
  // What to return when literally nothing served the request.
  //   "respond"    → a valid completion in the client's own format (no error)
  //   "passthrough"→ the last upstream error (debugging escape hatch)
  lastResort: "respond",
  // PandaOrchestrator (https://github.com/aicodeking/PandaOrchestrator) is the
  // model picker: a local ONNX task profiler + success head that scores a pool of
  // candidates by calibrated P(success), cost and latency and returns a ranked
  // order plus an escalation ladder. The router uses it to decide which
  // model/provider to try first and which next.
  panda: {
    enabled: true,
    baseUrl: "http://127.0.0.1:8765",
    mode: "max_utility",
    minPSuccess: 0.5,
    // Non-zero makes some picks non-greedy, so strong cards (e.g. GPT-6.1-Sol-Pro)
    // get used occasionally instead of always the cheapest plausible one.
    exploreEpsilon: 0.08,
    // Ask Panda even for provider rotation inside one model id (which seat first).
    decideProvider: true,
    // Choose at random among the top-K ranked seats instead of always taking the
    // single best one: spread across the fleet, no seat permanently first, and
    // still never a bottom-ranked model (K caps how low it may go).
    pickFromTopK: 3,
    timeoutMs: 1500,
  },
};

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;

function envInt(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envBool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function envStr(name, def) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return def;
  return String(raw).trim();
}

function float(value, def, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(Math.max(def, min), max);
  return Math.min(Math.max(n, min), max);
}

function int(value, def, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  // 0 is a meaningful value when the knob's floor is 0 ("disabled"), so only
  // fall back for values that cannot be represented at all.
  if (!Number.isFinite(n) || n < min) return Math.min(Math.max(def, min), max);
  return Math.min(Math.max(Math.round(n), min), max);
}

export function clampMaxAgentsConcurrency(value) {
  return int(value, DEFAULT_ROUTING_POLICY.maxAgentsConcurrency, MIN_CONCURRENCY, MAX_CONCURRENCY);
}

// Unknown or misspelled values fall back to the default brain rather than
// silently disabling routing intelligence.
export function normalizeRouterBrain(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "panda" || mode === "pandaonly" || mode === "panda-only") return "panda";
  if (mode === "jev" || mode === "systemone" || mode === "system-one" || mode === "smart") return "jev";
  if (mode === "merged" || mode === "both" || mode === "hybrid") return "merged";
  return DEFAULT_ROUTING_POLICY.routerBrain;
}

// Weights are relative, so they are normalised to sum 1. Both zero (or garbage)
// means "no preference": an even split rather than a division by zero.
function normalizeWeights(jev, panda) {
  const j = Math.max(0, Number(jev) || 0);
  const p = Math.max(0, Number(panda) || 0);
  const sum = j + p;
  if (!Number.isFinite(sum) || sum <= 0) return { jevWeight: 0.5, pandaWeight: 0.5 };
  return { jevWeight: j / sum, pandaWeight: p / sum };
}

/**
 * Merge stored settings with env overrides and defaults.
 * Precedence: defaults < env < settings.routingPolicy (dashboard wins).
 */
export function resolveRoutingPolicy(settings = {}) {
  const fromEnv = {
    enabled: envBool("OR_RESILIENCE_ENABLED", DEFAULT_ROUTING_POLICY.enabled),
    maxAgentsConcurrency: envInt("OR_MAX_AGENTS_CONCURRENCY", DEFAULT_ROUTING_POLICY.maxAgentsConcurrency),
    perConnectionConcurrency: envInt("OR_PER_CONNECTION_CONCURRENCY", DEFAULT_ROUTING_POLICY.perConnectionConcurrency),
    admissionQueueMs: envInt("OR_ADMISSION_QUEUE_MS", DEFAULT_ROUTING_POLICY.admissionQueueMs),
    failoverEnabled: envBool("OR_FAILOVER_ENABLED", DEFAULT_ROUTING_POLICY.failoverEnabled),
    hedgeMs: envInt("OR_HEDGE_MS", DEFAULT_ROUTING_POLICY.hedgeMs),
    hedgeMaxBytes: envInt("OR_HEDGE_MAX_BYTES", DEFAULT_ROUTING_POLICY.hedgeMaxBytes),
    maxFailoverRoutes: envInt("OR_MAX_FAILOVER_ROUTES", DEFAULT_ROUTING_POLICY.maxFailoverRoutes),
    hopBackoffMs: envInt("OR_HOP_BACKOFF_MS", DEFAULT_ROUTING_POLICY.hopBackoffMs),
    failoverDeadlineMs: envInt("OR_FAILOVER_DEADLINE_MS", DEFAULT_ROUTING_POLICY.failoverDeadlineMs),
    degradeCooldownMs: envInt("OR_DEGRADE_COOLDOWN_MS", DEFAULT_ROUTING_POLICY.degradeCooldownMs),
    routerBrain: envStr("OR_ROUTER_BRAIN", DEFAULT_ROUTING_POLICY.routerBrain),
    jevWeight: float(envStr("OR_JEV_WEIGHT", DEFAULT_ROUTING_POLICY.jevWeight), DEFAULT_ROUTING_POLICY.jevWeight, 0, 1),
    pandaWeight: float(envStr("OR_PANDA_WEIGHT", DEFAULT_ROUTING_POLICY.pandaWeight), DEFAULT_ROUTING_POLICY.pandaWeight, 0, 1),
    brainTimeoutMs: envInt("OR_BRAIN_TIMEOUT_MS", DEFAULT_ROUTING_POLICY.brainTimeoutMs),
    seatFairness: float(envStr("OR_SEAT_FAIRNESS", DEFAULT_ROUTING_POLICY.seatFairness), DEFAULT_ROUTING_POLICY.seatFairness, 0, 1),
    tierBias: float(envStr("OR_TIER_BIAS", DEFAULT_ROUTING_POLICY.tierBias), DEFAULT_ROUTING_POLICY.tierBias, 0, 1),
    seatFairnessWindowMs: envInt("OR_SEAT_FAIRNESS_WINDOW_MS", DEFAULT_ROUTING_POLICY.seatFairnessWindowMs),
    jevTimeoutMs: envInt("OR_JEV_TIMEOUT_MS", DEFAULT_ROUTING_POLICY.jevTimeoutMs),
    explicitModelSticky: envBool("OR_EXPLICIT_MODEL_STICKY", DEFAULT_ROUTING_POLICY.explicitModelSticky),
    midStreamSilent: envBool("OR_MID_STREAM_SILENT", DEFAULT_ROUTING_POLICY.midStreamSilent),
    lastResort: String(process.env.OR_LAST_RESORT || "").trim() || DEFAULT_ROUTING_POLICY.lastResort,
  };
  const stored = settings?.routingPolicy || {};

  const merged = { ...DEFAULT_ROUTING_POLICY, ...fromEnv, ...stored };
  return {
    enabled: merged.enabled !== false,
    maxAgentsConcurrency: clampMaxAgentsConcurrency(merged.maxAgentsConcurrency),
    perConnectionConcurrency: int(merged.perConnectionConcurrency, DEFAULT_ROUTING_POLICY.perConnectionConcurrency, 1, MAX_CONCURRENCY),
    admissionQueueMs: int(merged.admissionQueueMs, DEFAULT_ROUTING_POLICY.admissionQueueMs, 0, 120000),
    failoverEnabled: merged.failoverEnabled !== false,
    hedgeMs: int(merged.hedgeMs, DEFAULT_ROUTING_POLICY.hedgeMs, 0, 120000),
    hedgeMaxBytes: int(merged.hedgeMaxBytes, DEFAULT_ROUTING_POLICY.hedgeMaxBytes, 1024, 4194304),
    maxFailoverRoutes: int(merged.maxFailoverRoutes, DEFAULT_ROUTING_POLICY.maxFailoverRoutes, 0, 64),
    hopBackoffMs: int(merged.hopBackoffMs, DEFAULT_ROUTING_POLICY.hopBackoffMs, 0, 60000),
    failoverDeadlineMs: int(merged.failoverDeadlineMs, DEFAULT_ROUTING_POLICY.failoverDeadlineMs, 1000, GLOBAL_TIMEOUT_MS * 3),
    degradeCooldownMs: int(merged.degradeCooldownMs, DEFAULT_ROUTING_POLICY.degradeCooldownMs, 0, 900000),
    trimOnPromptCap: merged.trimOnPromptCap === true,
    midStreamSilent: merged.midStreamSilent !== false,
    // Per-combo choice wins over the global brain, so one combo can run merged
    // while another runs Panda-only.
    routerBrain: normalizeRouterBrain(merged.comboRouterBrain || merged.routerBrain),
    ...normalizeWeights(merged.jevWeight, merged.pandaWeight),
    brainTimeoutMs: int(merged.brainTimeoutMs, DEFAULT_ROUTING_POLICY.brainTimeoutMs, 0, 60000),
    seatFairness: float(merged.seatFairness, DEFAULT_ROUTING_POLICY.seatFairness, 0, 1),
    tierBias: float(merged.tierBias, DEFAULT_ROUTING_POLICY.tierBias, 0, 1),
    seatFairnessWindowMs: int(merged.seatFairnessWindowMs, DEFAULT_ROUTING_POLICY.seatFairnessWindowMs, 1000, 86_400_000),
    jevTimeoutMs: int(merged.jevTimeoutMs, DEFAULT_ROUTING_POLICY.jevTimeoutMs, 200, GLOBAL_TIMEOUT_MS),
    explicitModelSticky: merged.explicitModelSticky !== false,
    panda: {
      ...DEFAULT_ROUTING_POLICY.panda,
      ...(merged.panda || {}),
      enabled: (merged.panda?.enabled ?? DEFAULT_ROUTING_POLICY.panda.enabled) === true,
      decideProvider: (merged.panda?.decideProvider ?? DEFAULT_ROUTING_POLICY.panda.decideProvider) === true,
      pickFromTopK: int(merged.panda?.pickFromTopK, DEFAULT_ROUTING_POLICY.panda.pickFromTopK, 1, 20),
      baseUrl: String(merged.panda?.baseUrl || DEFAULT_ROUTING_POLICY.panda.baseUrl).replace(/\/+$/, ""),
      timeoutMs: int(merged.panda?.timeoutMs, DEFAULT_ROUTING_POLICY.panda.timeoutMs, 200, 15000),
      exploreEpsilon: Math.min(0.5, Math.max(0, Number(merged.panda?.exploreEpsilon) || 0)),
      minPSuccess: Math.min(1, Math.max(0, Number(merged.panda?.minPSuccess ?? 0.5))),
    },
    lastResort: merged.lastResort === "passthrough" ? "passthrough" : "respond",
  };
}

// Upstream rejections that mean "this route cannot serve this prompt right now"
// rather than "the request is invalid". These drive rotation; none of them is
// ever allowed to reach the client.
const CAP_TEXTS = [
  "prompt is longer",
  "free-tier cap",
  "free tier allows",
  "err_free_prompt_cap",
  "free_rate_limited",
  "context length",
  "context_window",
  "maximum context",
  "too many tokens",
  "token limit",
  "exceeds the model",
  "request too large",
  "payload too large",
];

export function isPromptCapError(message = "") {
  const text = String(message || "").toLowerCase();
  return CAP_TEXTS.some((needle) => text.includes(needle));
}
