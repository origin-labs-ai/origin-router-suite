// The routing strategy registry — the single source of truth for every strategy
// the router can run a combo with.
//
// v0.6.000 grew the router from 4 strategies (smart / fusion / round-robin /
// fallback) to 24 by porting the strategy families that made OmniRoute and
// 9Router interesting and adding OriginRouter-native ones. Every strategy is
// either:
//
//   kind: "orderer" — reorders the seat list before the fallback walk; the walk
//                     itself (seat-silence cuts, failover) is unchanged.
//   kind: "panel"   — runs several seats at once instead of one (fusion, pipeline).
//   kind: "brain"   — the router brain decides per request (smart, auto family).
//
// Quota-flavoured orderers (reset-aware, reset-window, headroom, quota-weighted,
// expiry-first) consume a pluggable quota snapshot source and fail open to
// fairness rotation when it is not wired — a strategy must never stop a request.
//
// The wizard, the combos editor and the onboarding API all read from here, so
// the count in the UI always equals the count the engine dispatches.

export const STRATEGY_KINDS = ["orderer", "panel", "brain"];

export const ROUTING_STRATEGIES = [
  // ─── Core four (the v0.5 set) ───────────────────────────────────────────────
  {
    id: "fallback",
    label: "Fallback",
    hint: "Sequential priority: first seat that answers wins",
    kind: "orderer",
    default: true,
  },
  {
    id: "smart",
    label: "Smart",
    hint: "The brain picks the seat, sticky sessions keep prompt cache warm",
    kind: "brain",
  },
  {
    id: "fusion",
    label: "Fusion",
    hint: "Several seats answer in parallel, a judge synthesizes one answer",
    kind: "panel",
  },
  {
    id: "round-robin",
    label: "Round robin",
    hint: "Every seat takes turns, sticky limit controls rotation cadence",
    kind: "orderer",
  },

  // ─── Deterministic spreaders (ported from OmniRoute's rotation family) ──────
  {
    id: "random",
    label: "Random",
    hint: "Freshly shuffled order each turn, held briefly to keep cache warm",
    kind: "orderer",
  },
  {
    id: "strict-random",
    label: "Strict random",
    hint: "Deck draw: every seat is used once before the deck reshuffles",
    kind: "orderer",
  },
  {
    id: "weighted",
    label: "Weighted",
    hint: "Distributes traffic by per-seat weight percentages",
    kind: "orderer",
    knob: "weights",
  },
  {
    id: "fill-first",
    label: "Fill first",
    hint: "Locks onto the first healthy seat and only moves when it dies",
    kind: "orderer",
  },
  {
    id: "p2c",
    label: "Power of two choices",
    hint: "Picks two random seats, sends the work to the healthier one",
    kind: "orderer",
  },
  {
    id: "least-used",
    label: "Least used",
    hint: "Fewest requests first, balancing load over the fairness window",
    kind: "orderer",
  },
  {
    id: "lkgp",
    label: "Last known good",
    hint: "Prioritizes the seat that last completed a request successfully",
    kind: "orderer",
  },

  // ─── Cost / context / cache aware ───────────────────────────────────────────
  {
    id: "cost-optimized",
    label: "Cost optimized",
    hint: "Cheapest seat first based on live pricing",
    kind: "orderer",
  },
  {
    id: "context-optimized",
    label: "Context optimized",
    hint: "Largest context window first for long conversations",
    kind: "orderer",
  },
  {
    id: "cache-optimized",
    label: "Cache optimized",
    hint: "Same reusable prompt prefix consistently lands on the same seat",
    kind: "orderer",
  },
  {
    id: "shadow-cache",
    label: "Shadow cache",
    hint: "Prefix affinity plus a local encrypted shadow cache of recent answers",
    kind: "orderer",
  },

  // ─── Quota family (fail open to fairness rotation without quota snapshots) ──
  {
    id: "reset-aware",
    label: "Reset aware",
    hint: "Balances remaining quota across reset windows, then rotates similar",
    kind: "orderer",
  },
  {
    id: "reset-window",
    label: "Reset window",
    hint: "Rotates seats grouped by their quota reset windows",
    kind: "orderer",
  },
  {
    id: "headroom",
    label: "Headroom",
    hint: "Most remaining quota first (1 − max utilization)",
    kind: "orderer",
  },
  {
    id: "quota-weighted",
    label: "Quota weighted",
    hint: "Picks among seats in proportion to leftover quota; pinned sessions stay",
    kind: "orderer",
  },
  {
    id: "expiry-first",
    label: "Expiry first",
    hint: "Spends the soonest-expiring quota first so nothing is wasted",
    kind: "orderer",
  },

  // ─── Adaptive family ────────────────────────────────────────────────────────
  {
    id: "auto",
    label: "Auto",
    hint: "Self-healing multi-factor scoring: health, cost, latency, task fit",
    kind: "brain",
  },
  {
    id: "autoaggressive",
    label: "Auto Agressive",
    hint: "Situationally adjusts: classifies the turn, tightens thresholds when seats degrade",
    kind: "brain",
  },
  {
    id: "latency-arbitrage",
    label: "Latency arbitrage",
    hint: "Real-time cost × speed × health arbitrage across the seats",
    kind: "orderer",
  },

  // ─── Panel family ───────────────────────────────────────────────────────────
  {
    id: "pipeline",
    label: "Pipeline",
    hint: "Runs seats in sequence, feeding each step's output into the next",
    kind: "panel",
  },
];

export const STRATEGY_IDS = ROUTING_STRATEGIES.map((s) => s.id);

// Historical / alternate names normalize onto the canonical ids, mirroring the
// migration aliases OmniRoute kept. Unknown ids fall back to "fallback" — a
// misspelled strategy must never disable routing.
export const STRATEGY_ALIASES = {
  priority: "fallback",
  sequential: "fallback",
  usage: "least-used",
  "least-loaded": "least-used",
  context: "context-optimized",
  "context-window": "context-optimized",
  "weekly-reset": "reset-window",
  "reset-window-order": "reset-window",
  "power-of-two-choices": "p2c",
  "cost-first": "cost-optimized",
  cheapest: "cost-optimized",
  "last-good-provider": "lkgp",
  max: "smart", // legacy preset id — the preset is now Mythos
  mythos: "smart",
  "revolt-deffusion": "smart",
  max_utility: "auto",
  aggressive: "autoaggressive",
};

export function normalizeStrategy(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return "fallback";
  const canonical = STRATEGY_ALIASES[id] || id;
  return STRATEGY_IDS.includes(canonical) ? canonical : "fallback";
}

export function getStrategy(id) {
  return ROUTING_STRATEGIES.find((s) => s.id === id) || null;
}

export function isPanelStrategy(id) {
  const s = getStrategy(normalizeStrategy(id));
  return s?.kind === "panel";
}

export function isBrainStrategy(id) {
  const s = getStrategy(normalizeStrategy(id));
  return s?.kind === "brain";
}

export function isOrdererStrategy(id) {
  const s = getStrategy(normalizeStrategy(id));
  return s?.kind === "orderer";
}

export function listStrategies() {
  return ROUTING_STRATEGIES.map(({ id, label, hint, kind, knob, default: dflt }) => ({
    id,
    label,
    hint,
    kind,
    ...(knob ? { knob } : {}),
    ...(dflt ? { default: true } : {}),
  }));
}
