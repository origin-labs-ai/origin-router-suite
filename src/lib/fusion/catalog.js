// The Revolt Fusion feature catalog — the bridge between "featherlight base"
// and "Monster Homelab Hub Rebel Strike Mode".
//
// Design (the owner's architecture, from the Argon planning chat):
//   - The base OriginRouter install stays featherlight: 90% of daily developers
//     never download a single extra byte.
//   - The heavy concepts ported from the reference platforms (extended
//     provider pool, the full MCP tool catalog, guardrails, A2A, deterministic
//     YAML routing, ELO rankings, availability state machine, stream recovery,
//     advanced compression engines, skills packs) live in an EXTENSION PACK.
//   - The user picks a setup tier — Daily Code (nothing extra), Pro (hand-pick
//     categories), MHHRSM (everything) — and the loader hydrates exactly those
//     categories into <DATA_DIR>/fusion-modules/, verified and fail-open.
//   - No third-party repo is ever touched at runtime: the pack source is ours
//     (origin-labs-ai/revolt-fusion) or a local directory for development.
//
// This file is pure data + helpers — no I/O, no imports. Everything else in
// the fusion system reads the shape from here.

export const SETUP_TIERS = [
  {
    id: "daily",
    label: "Daily Code",
    tagline: "Featherlight — ready in 0s",
    description:
      "Cursor, Claude Code, Cline on a laptop. Core providers, the Panda+Jev brain, the token saver, hedged concurrency. Zero extra download.",
    features: [], // nothing extra — the base install IS the daily tier
  },
  {
    id: "pro",
    label: "Pro",
    tagline: "Pick your customs",
    description:
      "Hand-pick the heavy categories you actually want. Each one hydrates on demand, each one can be removed again.",
    features: null, // user's hand-pick from CATEGORIES
  },
  {
    id: "monster",
    label: "MHHRSM",
    tagline: "Monster Homelab Hub Rebel Strike Mode",
    description:
      "The full extension pack: every category, hyper-tuned. Heavy server, multi-user gateway, everything the references had — natively and in plain JS.",
    features: null, // all categories
  },
  {
    id: "ultra",
    label: "Ultra Ultimate Max",
    tagline: "Everything, at absolute peak",
    description:
      "Every category, every knob at maximum, everything native and built-in: max concurrency, max failover routes, ultra compression, every brain, every strategy, every engine — the absolute monster, nothing held back, nothing left disabled.",
    features: null, // all categories — with peak:true flagging the tuning pass
    peak: true,
  },
];

// The heavy categories. `moduleKey` names the module the loader must place in
// <DATA_DIR>/fusion-modules/ for the feature to activate. `defaultOn` marks
// what Pro users most commonly want pre-checked.
export const CATEGORIES = [
  {
    id: "providers-plus",
    label: "Extended Providers",
    hint: "The deeper provider pool beyond the 142 base entries — resellers, regional clouds, media specialists.",
    moduleKey: "providers-plus",
    defaultOn: true,
  },
  {
    id: "mcp-tools",
    label: "Full MCP Server",
    hint: "The complete tool catalog over the JSON-RPC surface — GitHub, memory, ops, compression tools.",
    moduleKey: "mcp-tools",
    defaultOn: true,
  },
  {
    id: "guardrails",
    label: "Prompt Guardrails",
    hint: "Injection-detection and policy checks between the client prompt and the upstream call.",
    moduleKey: "guardrails",
    defaultOn: false,
  },
  {
    id: "a2a",
    label: "A2A Agent Protocol",
    hint: "Agent card, task lifecycle and streaming for agent-to-agent callers.",
    moduleKey: "a2a",
    defaultOn: false,
  },
  {
    id: "yaml-routing",
    label: "Deterministic YAML Routing",
    hint: "A declarative strategy block for self-hosted gateway deployments.",
    moduleKey: "yaml-routing",
    defaultOn: false,
  },
  {
    id: "rankings",
    label: "Free-Tier Rankings",
    hint: "ELO-joined free-tier rankings so the free lanes sort by real quality.",
    moduleKey: "rankings",
    defaultOn: false,
  },
  {
    id: "availability",
    label: "Availability State Machine",
    hint: "Per-credential AVAILABLE → QUOTA_EXHAUSTED → UNHEALTHY tracking with terminal states.",
    moduleKey: "availability",
    defaultOn: true,
  },
  {
    id: "stream-recovery",
    label: "Mid-Stream Recovery",
    hint: "Delivered-prefix snapshots that let a dead stream continue on the next seat.",
    moduleKey: "stream-recovery",
    defaultOn: true,
  },
  {
    id: "compression-engines",
    label: "Advanced Compression Engines",
    hint: "The stacked engine registry with fidelity and risk gates, on top of OriginFold + RTK.",
    moduleKey: "compression-engines",
    defaultOn: false,
  },
  {
    id: "skills",
    label: "Skills Pack",
    hint: "The code-fusion skills pipeline — deduped, merged, installable in one click.",
    moduleKey: "skills",
    defaultOn: false,
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// Resolve a tier + optional hand-pick into the concrete feature set.
export function resolveFeatures(tier, handPicked) {
  const t = SETUP_TIERS.find((x) => x.id === tier) || SETUP_TIERS[0];
  if (t.id === "daily") return [];
  if (t.id === "monster" || t.id === "ultra") return [...CATEGORY_IDS];
  if (t.id === "pro") {
    if (handPicked === null || handPicked === undefined) {
      return CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id);
    }
    if (!Array.isArray(handPicked)) return [];
    return handPicked.filter((id) => CATEGORY_IDS.includes(id));
  }
  return [];
}

// True for tiers that also want the peak-tuning pass applied (Ultra Ultimate
// Max): routing policy maxed, compression ultra, every brain live.
export function isPeakTier(tier) {
  return SETUP_TIERS.find((x) => x.id === tier)?.peak === true;
}

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

export function getTier(id) {
  return SETUP_TIERS.find((t) => t.id === id) || null;
}
