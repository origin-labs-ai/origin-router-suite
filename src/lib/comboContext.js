import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { ALIAS_TO_ID } from "@/shared/constants/providers";

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

  const lookup = (name) => {
    if (!combosByName) return null;
    if (typeof combosByName.get === "function") return combosByName.get(name) ?? null;
    return combosByName[name] ?? null;
  };

  const slash = seat.indexOf("/");
  if (slash <= 0) {
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
    const caps = getCapabilitiesForModel(null, seat);
    return Number.isFinite(caps?.contextWindow) ? caps.contextWindow : null;
  }

  const alias = seat.slice(0, slash);
  const providerId = ALIAS_TO_PROVIDER_ID[alias] || alias;
  const caps = getCapabilitiesForModel(providerId, seat.slice(slash + 1));
  return Number.isFinite(caps?.contextWindow) ? caps.contextWindow : null;
}

/**
 * Seats that cannot honour `limit`. Unknown windows are allowed through — the
 * catalog is incomplete by design and blocking on a guess would be worse than
 * letting the request fail upstream.
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
