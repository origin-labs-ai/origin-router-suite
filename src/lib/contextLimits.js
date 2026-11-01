// Context windows are reported exactly as the provider/catalog declares them.
// 1M is the maximum a model or combo may advertise, not a floor: applying a
// 1M floor to every model made the playground label every entry "1M" and made
// its context filter unable to narrow anything.
export const MAX_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Normalize a declared context window.
 *
 * Known values are preserved (and capped at the 1M ceiling); unknown or invalid
 * values fall back to the 200K default instead of claiming the maximum.
 *
 * @param {number|string|null|undefined} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function ensureMaxContextWindow(value, fallback = DEFAULT_CONTEXT_WINDOW) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return Math.min(Math.max(Number(fallback) || DEFAULT_CONTEXT_WINDOW, 1), MAX_CONTEXT_WINDOW);
  }
  return Math.min(Math.floor(tokens), MAX_CONTEXT_WINDOW);
}

/** Normalize a capability object without mutating the capability table. */
export function withMaxContextWindow(caps) {
  if (!caps) return caps;
  return { ...caps, contextWindow: ensureMaxContextWindow(caps.contextWindow) };
}

/**
 * Context values offered by the playground picker for a model that supports
 * `maxWindow` tokens. The model's own window is always offered, even when it is
 * not one of the round presets (for example 262144 or 400000).
 */
export const CONTEXT_PRESETS = [32000, 64000, 128000, 200000, 256000, 512000, 1000000];

export function contextWindowOptions(maxWindow) {
  const max = ensureMaxContextWindow(maxWindow);
  const options = CONTEXT_PRESETS.filter((value) => value <= max);
  if (!options.includes(max)) options.push(max);
  return options.sort((a, b) => a - b);
}

/** Default selection for the picker: 200K, clamped to what the model supports. */
export function defaultContextWindow(maxWindow) {
  const max = ensureMaxContextWindow(maxWindow);
  return Math.min(DEFAULT_CONTEXT_WINDOW, max);
}
