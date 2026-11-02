// Context windows are reported exactly as the provider/catalog declares them.
// 1M is the maximum a model or combo may advertise, not a floor: applying a
// 1M floor to every model made the playground label every entry "1M" and made
// its context filter unable to narrow anything.
// 1,048,576 is the number Claude Code sends for its "[1m]" tier. Clamping a
// model at 1,000,000 while the combo ceiling is 1,048,576 made every member look
// short by 48,576 tokens, so the editor flagged models that actually do serve the
// full window. The ceiling is therefore the binary number.
export const MAX_CONTEXT_WINDOW = 1_048_576;
export const DEFAULT_CONTEXT_WINDOW = 200_000;

// open-sse/providers/capabilities.js merges every lookup over
// DEFAULT_CAPABILITIES, whose contextWindow (200000) is a *safe runtime floor*,
// not a statement about the model. Display layers must not present that floor as
// the model's limit, so it is exported here for one comparison:
// a value equal to it means "nobody actually declared anything".
export const UNDECLARED_CONTEXT_WINDOW = 200_000;

/**
 * Was this window declared by a provider record, the catalog or the owner's
 * ceiling file — or is it just the capability table's fallback floor?
 */
export function isDeclaredContextWindow(value) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 && tokens !== UNDECLARED_CONTEXT_WINDOW;
}

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

/**
 * Normalize a capability object without mutating the capability table.
 *
 * `contextWindow` becomes null when the only number available is the floor, and
 * `contextDeclared` records that distinction, so badges can render "not declared"
 * instead of a made-up limit. Selection defaults still use
 * ensureMaxContextWindow() separately.
 */
export function withMaxContextWindow(caps) {
  if (!caps) return caps;
  const declared = isDeclaredContextWindow(caps.contextWindow);
  return {
    ...caps,
    contextWindow: declared ? Math.min(Math.floor(Number(caps.contextWindow)), MAX_CONTEXT_WINDOW) : null,
    contextDeclared: declared,
  };
}

export const CONTEXT_PRESETS = [32000, 64000, 128000, 200000, 256000, 512000, 1000000];

/**
 * Context values offered by the playground picker for a model that supports
 * `maxWindow` tokens. The model's own window is always offered, even when it is
 * not one of the round presets (for example 262144 or 400000).
 *
 * An undeclared window means nobody said anything, which is not evidence the model
 * is small: offering only up to the 200K floor for those made every unknown seat
 * look like it could not take 1M. Unknown therefore gets the full ladder.
 */
export function contextWindowOptions(maxWindow) {
  const tokens = Number(maxWindow);
  const max = Number.isFinite(tokens) && tokens > 0
    ? Math.min(Math.floor(tokens), MAX_CONTEXT_WINDOW)
    : MAX_CONTEXT_WINDOW;
  const options = CONTEXT_PRESETS.filter((value) => value <= max);
  if (!options.includes(max)) options.push(max);
  return options.sort((a, b) => a - b);
}

/** Default selection for the picker: 200K, clamped to what the model supports. */
export function defaultContextWindow(maxWindow) {
  const max = ensureMaxContextWindow(maxWindow);
  return Math.min(DEFAULT_CONTEXT_WINDOW, max);
}
