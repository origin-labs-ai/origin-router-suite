import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { MAX_CONTEXT_WINDOW } from "@/lib/contextLimits";

// Owner-raised ceilings are passed in by the server routes (from
// ~/.or/context-ceilings.json). This module stays importable from the dashboard
// bundle, so it must not touch node:fs or the catalog cache module.
let injectedOverrides = {};

export function setContextCeilingOverrides(map) {
  injectedOverrides = map && typeof map === "object" ? map : {};
}

// Combo seats are written with UI aliases (cc, oc, kr, …) while the capability
// tables are keyed by provider id (claude, opencode, kiro, …). Same mapping the
// /v1/models builder uses, kept in one place so the editor and the API agree.
const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
  ),
  ...ALIAS_TO_ID,
};

function seatsOf(comboOrModels) {
  if (Array.isArray(comboOrModels)) return comboOrModels;
  if (Array.isArray(comboOrModels?.models)) return comboOrModels.models;
  return [];
}

/**
 * A context window someone actually DECLARED for this exact model.
 *
 * Three sources count as evidence: the owner's ceiling override and a declared
 * number in the static provider registry. The capability table is deliberately
 * excluded: for models it has never seen it falls back to a name heuristic (`deepseek*` → 128K, an unknown `-free` card → 200K), and using that
 * guess as a hard ceiling blocked perfectly good 1M seats from joining a combo.
 * No evidence means unknown, and unknown is allowed through.
 */
export function declaredContextWindow(providerId, model) {
  const overrides = injectedOverrides;
  const explicit = Number(
    overrides[`${providerId}/${model}`] ?? overrides[model] ?? overrides[`${providerId}/${model}`.toLowerCase()],
  );
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(explicit, MAX_CONTEXT_WINDOW);
  }

  if (providerId) {
    try {
      const entry = (getModelsByProviderId(providerId) || []).find((m) => m.id === model);
      const registryWindow = Number(entry?.contextWindow ?? entry?.caps?.contextWindow);
      if (Number.isFinite(registryWindow) && registryWindow > 0) {
        return Math.min(registryWindow, MAX_CONTEXT_WINDOW);
      }
    } catch { /* provider has no static list */ }
  }

  return null;
}

/**
 * Declared context window for one combo seat, in tokens.
 *
 * A seat is either `alias/model` or the name of another combo (nested combo).
 * Nested combos resolve to the smallest window across their own seats, because
 * any member may serve the request. Returns null when the catalog has no
 * opinion — callers must treat null as "unknown", never as "too small".
 *
 * @param {string} seat
 * @param {Map<string, any>|Record<string, any>} combosByName
 * @param {Set<string>} [visiting] cycle guard for nested combos
 * @returns {number|null}
 */
export function resolveSeatContextWindow(seat, combosByName, visiting = new Set()) {
  if (typeof seat !== "string" || !seat) return null;

  const slash = seat.indexOf("/");
  if (slash <= 0) {
    const lookup = (name) => {
      if (!combosByName) return null;
      if (typeof combosByName.get === "function") return combosByName.get(name) ?? null;
      return combosByName[name] ?? null;
    };
    const nested = lookup(seat);
    if (nested) {
      if (visiting.has(seat)) return null;
      visiting.add(seat);
      let smallest = Infinity;
      try {
        for (const inner of seatsOf(nested)) {
          const window = resolveSeatContextWindow(inner, combosByName, visiting);
          if (Number.isFinite(window)) smallest = Math.min(smallest, window);
        }
      } finally {
        visiting.delete(seat);
      }
      return Number.isFinite(smallest) ? smallest : null;
    }
    // A bare model name: only a declared registry/catalog number counts.
    return declaredContextWindow(null, seat);
  }

  const alias = seat.slice(0, slash);
  const providerId = ALIAS_TO_PROVIDER_ID[alias] || alias;
  const model = seat.slice(slash + 1);
  return declaredContextWindow(providerId, model) ?? declaredContextWindow(alias, model);
}

/**
 * Seats that cannot honour `limit`, judged only on declared numbers.
   Unknown windows are allowed through — the catalog is incomplete by design and
   blocking on a name heuristic would punish the owner for our missing data.
 *
 * @param {string[]} seats
 * @param {number} limit
 * @param {Map<string, any>|Record<string, any>} [combosByName]
 * @returns {{ seat: string, contextWindow: number }[]}
 */
export function findSeatsBelowContext(seats, limit, combosByName) {
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0) return [];
  const offenders = [];
  const seen = new Set();
  for (const seat of Array.isArray(seats) ? seats : []) {
    const window = resolveSeatContextWindow(seat, combosByName);
    if (Number.isFinite(window) && window < max && !seen.has(seat)) {
      seen.add(seat);
      offenders.push({ seat, contextWindow: window });
    }
  }
  return offenders;
}

/**
 * Human summary used in API error messages: "cc/haiku (200K)".
 */
export function describeContextShort(offenders) {
  return (offenders || [])
    .map(({ seat, contextWindow }) => `${seat} (${Math.round(contextWindow / 1000)}K)`)
    .join(", ");
}
