// Providers whose executor runs a program on THIS machine instead of calling a
// remote API. They are the only entries in the registry where "route a request"
// and "execute code as the OS user" are the same sentence, so they are opt-in.
//
// One flag here is read in two places that must agree:
//   • the provider card (src/app/(dashboard)/dashboard/providers/page.js) —
//     shows the entry only when the switch is on, even though the registry
//     entry keeps `hidden: true` so every other surface stays clean;
//   • the /v1 route (src/sse/services/localExecutorGate.js) — refuses a model
//     while the switch is off, whatever the UI, a combo or a direct API call
//     asks for. The route check is the real gate; hiding the card is cosmetic.
//
// Adding a provider here is deliberate: it needs a settings key in
// DEFAULT_SETTINGS.localExecutors and a human explanation on the card.
export const LOCAL_EXECUTOR_FLAGS = {
  "devin-cli": "devinCli",
};

/** True when the provider executes a local program (nothing to gate otherwise). */
export function isLocalExecutor(providerId) {
  return Boolean(providerId && LOCAL_EXECUTOR_FLAGS[providerId]);
}

/**
 * Whether this provider may run. Providers that are not local executors are
 * always allowed — the switch only ever gates the entries listed above.
 * Strict `=== true`: a missing flag, a string "false" or a partial settings
 * object all read as OFF, which is the safe direction.
 */
export function isLocalExecutorEnabled(settings, providerId) {
  if (!isLocalExecutor(providerId)) return true;
  const flag = LOCAL_EXECUTOR_FLAGS[providerId];
  return settings?.localExecutors?.[flag] === true;
}

/** Every settings flag that exists, for defaults and the UI. */
export const LOCAL_EXECUTOR_SETTING_KEYS = Object.values(LOCAL_EXECUTOR_FLAGS);
