/**
 * HydraFusion — the orchestration ladder that replaced the Fusion strategy.
 *
 * One combo, six effort tiers. A tier decides three independent knobs:
 *   - how many seats draft in parallel           (panel)
 *   - how many refinement stages a cascade runs  (cascadeStages)
 *   - how many auditors read the drafts          (critics)
 *
 * The pattern decides the shape of the run, the tier decides its depth. Keeping
 * the two separate is what makes "Single at Max" and "Critique at Low" both
 * meaningful instead of one collapsing into the other.
 *
 * Pure data only: the dashboard imports this file too, so no node built-ins.
 */

export const HYDRAFUSION_DEFAULT_EFFORT = "high";
export const HYDRAFUSION_DEFAULT_PATTERN = "auto";

/**
 * `reasoningEffort` is what the router forwards as `reasoning_effort`; the
 * provider layer clamps it to the model's real ladder. "Ultra" deliberately
 * forwards `max` — its extra quality comes from the orchestration, not from a
 * fictitious provider tier.
 */
export const HYDRAFUSION_EFFORTS = Object.freeze([
  {
    id: "low",
    label: "Low",
    hint: "Two seats, light thinking. The everyday quick pass.",
    reasoningEffort: "low",
    panel: 2,
    cascadeStages: 2,
    critics: 0,
    graceMs: 3000,
    hardTimeoutMs: 60000,
    runBudgetMs: 30000,
  },
  {
    id: "medium",
    label: "Medium",
    hint: "Five-seat panel over the pool, judge synthesis.",
    reasoningEffort: "medium",
    panel: 5,
    cascadeStages: 3,
    critics: 0,
    graceMs: 7000,
    hardTimeoutMs: 120000,
    runBudgetMs: 60000,
  },
  {
    id: "high",
    label: "High",
    hint: "Six-seat panel, judge synthesis, one auditor.",
    reasoningEffort: "high",
    panel: 6,
    cascadeStages: 3,
    critics: 1,
    graceMs: 9000,
    hardTimeoutMs: 150000,
    runBudgetMs: 100000,
  },
  {
    id: "xhigh",
    label: "Extra High",
    hint: "Eight-seat panel plus two auditors before the final answer.",
    reasoningEffort: "xhigh",
    panel: 8,
    cascadeStages: 4,
    critics: 2,
    graceMs: 11000,
    hardTimeoutMs: 180000,
    runBudgetMs: 130000,
  },
  {
    id: "max",
    label: "Max",
    hint: "Ten seats, three independent auditors, one corrected synthesis.",
    reasoningEffort: "max",
    panel: 10,
    cascadeStages: 5,
    critics: 3,
    graceMs: 13000,
    hardTimeoutMs: 210000,
    runBudgetMs: 160000,
  },
  {
    id: "ultra",
    label: "Ultra",
    hint: "Twelve seats, four auditors, longest deliberation. The pixel band lit.",
    reasoningEffort: "max",
    panel: 12,
    cascadeStages: 6,
    critics: 4,
    graceMs: 16000,
    hardTimeoutMs: 240000,
    runBudgetMs: 200000,
  },
]);

/** The six visual stops of the slider. `ultra: true` lights the pixel band. */
export const HYDRAFUSION_STOPS = Object.freeze(
  HYDRAFUSION_EFFORTS.map((tier) => ({
    key: tier.id,
    label: tier.label,
    effort: tier.reasoningEffort,
    ultra: tier.id === "ultra",
  })),
);

export const HYDRAFUSION_PATTERNS = Object.freeze([
  {
    id: "auto",
    label: "Auto",
    hint: "Cascade through Medium, Critique from High",
  },
  {
    id: "single",
    label: "Single",
    hint: "One seat answers directly — effort only changes its thinking budget",
  },
  {
    id: "cascade",
    label: "Cascade",
    hint: "Draft, then refine in sequence; the judge writes the final answer",
  },
  {
    id: "critique",
    label: "Critique",
    hint: "Panel drafts in parallel, auditors attack them, the judge corrects",
  },
]);

const EFFORT_SYNONYMS = {
  // Lowest tier. These are four spellings of the same level, never four stops.
  minimal: "low",
  minimum: "low",
  light: "low",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  extra: "xhigh",
  extrahigh: "xhigh",
  "extra high": "xhigh",
  xhigh: "xhigh",
  max: "max",
  maximum: "max",
  ultra: "ultra",
  ultracode: "ultra",
};

export function resolveHydraEffort(value) {
  const raw = String(value || "").trim().toLowerCase();
  const id = EFFORT_SYNONYMS[raw] || raw;
  return (
    HYDRAFUSION_EFFORTS.find((tier) => tier.id === id) ||
    HYDRAFUSION_EFFORTS.find((tier) => tier.id === HYDRAFUSION_DEFAULT_EFFORT) ||
    HYDRAFUSION_EFFORTS[0]
  );
}

export function normalizeHydraPattern(value) {
  const id = String(value || "").trim().toLowerCase();
  return HYDRAFUSION_PATTERNS.some((pattern) => pattern.id === id) ? id : HYDRAFUSION_DEFAULT_PATTERN;
}

/** Which pattern "auto" resolves to at a given depth. */
export function defaultHydraPattern(effortId) {
  const tier = resolveHydraEffort(effortId);
  if (tier.id === "high" || tier.id === "xhigh" || tier.id === "max" || tier.id === "ultra") {
    return "critique";
  }
  if (tier.id === "low" || tier.id === "medium") return "cascade";
  return "single";
}

export function resolveHydraPattern(pattern, effortId) {
  const requested = normalizeHydraPattern(pattern);
  return requested === "auto" ? defaultHydraPattern(effortId) : requested;
}

/**
 * Model families. The pool intentionally carries several provider aliases of
 * the same model; a panel of six aliases has the diversity of one model. These
 * rules let the conductor pick one seat per family before filling extras.
 */
export const HYDRAFUSION_FAMILIES = Object.freeze([
  // A frontier-class seat outranks the free aliases by family priority: one
  // Kimi K3.1 Pro in the pool must not be buried behind twelve DeepSeek-Flash
  // copies — or behind an abliterated Kimi variant, which is a different and
  // weaker model despite sharing the name.
  { id: "kimi-pro", match: /kimi[-_/. ]*k3\.1[-_/. ]*pro|moonshotai\/kimi-k3\.1-pro/i },
  { id: "uncensored", match: /abliterated|uncensored/i },
  { id: "kimi", match: /kimi|moonshot/i },
  { id: "deepseek-pro", match: /deepseek[-_/. ]*v?4(?:\.1)?[-_/. ]*pro|deepseek[-_/. ]*pro|~deepseek\/deepseek-pro/i },
  { id: "deepseek-flash", match: /deepseek[-_/. ]*v?4(?:\.1)?[-_/. ]*flash|deepseek[-_/. ]*flash|deepseek-chat|DeepSeek-V4/i },
  { id: "glm", match: /glm[-_/. ]*5/i },
  { id: "minimax", match: /minimax|m3\.1/i },
  { id: "qwen", match: /qwen/i },
  { id: "atria", match: /atria/i },
  { id: "hy4", match: /hy4|hunyuan/i },
  { id: "ernie", match: /ernie/i },
  { id: "dots", match: /dots/i },
  { id: "longcat", match: /longcat/i },
  { id: "mimo", match: /mimo/i },
  { id: "qf", match: /qfmodel/i },
  { id: "ling", match: /ling/i },
  { id: "inkling", match: /inkling/i },
  { id: "crouton", match: /crouton/i },
  { id: "other", match: /.*/ },
]);

export const HYDRAFUSION_CATEGORIES = Object.freeze([
  "code",
  "math",
  "science",
  "knowledge",
  "writing",
  "agentic",
  "general",
]);

/** Family priority per request category. Best-fit first, then the rest. */
export const HYDRAFUSION_CATEGORY_ORDER = Object.freeze({
  code: ["kimi-pro", "kimi", "deepseek-pro", "glm", "minimax", "qwen", "deepseek-flash", "atria", "ernie", "longcat"],
  math: ["kimi-pro", "kimi", "deepseek-pro", "glm", "qwen", "minimax", "deepseek-flash", "atria", "ernie", "longcat"],
  science: ["kimi-pro", "kimi", "glm", "deepseek-pro", "qwen", "minimax", "atria", "deepseek-flash", "ernie", "longcat"],
  knowledge: ["kimi-pro", "kimi", "glm", "deepseek-pro", "qwen", "ernie", "deepseek-flash", "minimax", "atria", "longcat"],
  writing: ["kimi-pro", "kimi", "atria", "minimax", "deepseek-flash", "glm", "qwen", "dots", "ernie", "longcat"],
  agentic: ["kimi-pro", "kimi", "deepseek-pro", "glm", "minimax", "qwen", "deepseek-flash", "atria", "ernie", "longcat"],
  general: ["kimi-pro", "kimi", "atria", "deepseek-pro", "glm", "minimax", "deepseek-flash", "qwen", "ernie", "longcat"],
});

export function hydraFamilyOf(model) {
  const text = String(model || "");
  for (const family of HYDRAFUSION_FAMILIES) {
    if (family.match.test(text)) return family.id;
  }
  return "other";
}

/**
 * Rank the pool for one request: one seat per family in category priority
 * order, then a second seat per family, and so on. Alias rotation happens
 * inside each family so repeated requests spread provider load without ever
 * collapsing the panel to one model.
 */
export function rankHydraSeats(models = [], category = "general", seed = "") {
  const seats = [...new Set((Array.isArray(models) ? models : []).filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))];
  if (seats.length === 0) return [];
  const byFamily = new Map();
  for (const model of seats) {
    const family = hydraFamilyOf(model);
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(model);
  }
  const priority = HYDRAFUSION_CATEGORY_ORDER[category] || HYDRAFUSION_CATEGORY_ORDER.general;
  const families = [
    ...priority.filter((family) => byFamily.has(family)),
    ...[...byFamily.keys()].filter((family) => !priority.includes(family)).sort(),
  ];
  const maxRounds = Math.max(...[...byFamily.values()].map((list) => list.length));
  const out = [];
  for (let round = 0; round < maxRounds; round += 1) {
    for (const family of families) {
      const list = seed ? rotateBySeed(byFamily.get(family) || [], `${seed}:${family}`) : (byFamily.get(family) || []);
      if (list[round] && !out.includes(list[round])) out.push(list[round]);
    }
  }
  return out;
}

/**
 * Rotate a list by a stable seed. HydraFusion sits on top of a pool (the
 * claude-opus-5-5 combo has ~40 seats); every run samples from a different
 * offset, so the whole pool gets used across requests instead of the same
 * first N models forever. With no seed the order is untouched.
 */
function rotateBySeed(list, seed) {
  if (!seed || list.length <= 1) return list;
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const offset = (hash >>> 0) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

/**
 * Build the call plan. Pure and deterministic so the dashboard can preview it
 * and the tests can assert it without touching a model.
 *
 * `panel` are the drafting seats (in order). `stages` are the cascade seats.
 * `critics` are auditing seats, never the judge when another seat is available.
 * `seed` rotates the seat sample across the pool.
 */
export function planHydraRun({ models = [], judgeModel = "", effort = HYDRAFUSION_DEFAULT_EFFORT, pattern = HYDRAFUSION_DEFAULT_PATTERN, seed = "", preserveOrder = false } = {}) {
  const tier = resolveHydraEffort(effort);
  const shape = resolveHydraPattern(pattern, tier.id);
  const seats = [...new Set(models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))];
  if (seats.length === 0) {
    return { effort: tier, pattern: shape, seats, judge: "", panel: [], stages: [], critics: [] };
  }
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : seats[0];
  const draftSeats = seats.filter((m) => m !== judge);
  const pool = preserveOrder
    ? (draftSeats.length > 0 ? draftSeats : seats)
    : rotateBySeed(draftSeats.length > 0 ? draftSeats : seats, seed);

  const panel = shape === "single" ? [] : pool.slice(0, Math.max(1, tier.panel));
  const stages = shape === "cascade" ? pool.slice(0, Math.max(1, tier.cascadeStages)) : [];
  // Auditors prefer seats that did not draft, then the judge, then a drafter.
  // That keeps the audit independent whenever the combo has spare seats.
  const drafters = shape === "cascade" ? stages : panel;
  const criticPool = shape === "single"
    ? []
    : [
        ...(preserveOrder
          ? pool.filter((m) => !drafters.includes(m))
          : rotateBySeed(pool.filter((m) => !drafters.includes(m)), `${seed}:critics`)),
        ...(judge ? [judge] : []),
        ...drafters,
      ].filter((m, i, all) => all.indexOf(m) === i);
  const critics = criticPool.slice(0, Math.max(0, tier.critics));

  return { effort: tier, pattern: shape, seats, judge, panel, stages, critics };
}
