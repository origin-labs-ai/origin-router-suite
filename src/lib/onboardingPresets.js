// The routing presets the first-run wizard offers for a new combo.
//
// Three choices, and they have to mean something:
//
//   max              - everything turned up. The brain blends Jev and Panda and
//                      the smart router picks the seat, the token saver works
//                      at its hardest and every lane may run at once.
//   revolt-deffusion - the same brain, but the token compression sits in the
//                      middle. Fast enough to stay readable, quiet enough to
//                      save real tokens.
//   custom           - the user decides; nothing is written behind their back.
//
// The numbers are the same ones the routing policy clamps to, so a preset can
// never write a value the router would reject.

export const COMBO_STRATEGY_PRESETS = [
  {
    id: "max",
    label: "Max",
    tagline: "Everything maxed",
    description:
      "Maximum token compression and optimisation. The brain blends Jev and Panda with the smart router on top, every seat may run at once and nothing is trimmed.",
    comboStrategy: {
      fallbackStrategy: "smart",
      routerBrain: "merged",
      smartPolicy: "smart",
      sessionSticky: true,
      confidenceThreshold: 0.8,
    },
    settings: {
      routingPolicy: {
        maxAgentsConcurrency: 64,
        perConnectionConcurrency: 64,
        admissionQueueMs: 120000,
        hedgeMs: 120000,
        hedgeMaxBytes: 4194304,
        maxFailoverRoutes: 64,
        hopBackoffMs: 0,
        degradeCooldownMs: 900000,
        seatSilenceMs: 120000,
        brainTimeoutMs: 60000,
        jevTimeoutMs: 120000,
        seatFairness: 1,
        tierBias: 1,
        jevWeight: 0.5,
        pandaWeight: 0.5,
        panda: {
          exploreEpsilon: 0.3,
          pickFromTopK: 10,
          timeoutMs: 15000,
          minPSuccess: 0.2,
        },
      },
      tokenSaver: {
        rtkEnabled: true,
        cavemanEnabled: true,
        cavemanLevel: "ultra",
        ponytailEnabled: true,
        ponytailLevel: "ultra",
        headroomEnabled: true,
        headroomCompressUserMessages: true,
      },
    },
  },
  {
    id: "revolt-deffusion",
    label: "RevoltDeffusion",
    tagline: "Balanced compression",
    description:
      "Jev and Panda decide together and the token compression sits in the middle. The fastest lanes keep their quota and the answers stay readable.",
    comboStrategy: {
      fallbackStrategy: "smart",
      routerBrain: "merged",
      smartPolicy: "smart",
      sessionSticky: true,
      confidenceThreshold: 0.8,
    },
    settings: {
      routingPolicy: {
        jevWeight: 0.45,
        pandaWeight: 0.55,
        brainTimeoutMs: 3500,
        seatFairness: 0.3,
        tierBias: 0.18,
        jevTimeoutMs: 8000,
      },
      tokenSaver: {
        rtkEnabled: true,
        cavemanEnabled: true,
        cavemanLevel: "full",
        ponytailEnabled: true,
        ponytailLevel: "full",
        headroomEnabled: false,
        headroomCompressUserMessages: false,
      },
    },
  },
  {
    id: "custom",
    label: "Select your own",
    tagline: "You decide",
    description:
      "Nothing is written behind your back. Pick the routing strategy, the brain and the compression yourself.",
    comboStrategy: null,
    settings: {},
  },
];

export const FALLBACK_STRATEGIES = [
  { id: "smart", label: "Smart", hint: "The brain picks the seat" },
  { id: "fusion", label: "Fusion", hint: "Several seats answer at once" },
  { id: "round-robin", label: "Round robin", hint: "Every seat takes turns" },
  { id: "fallback", label: "Fallback", hint: "First seat that answers" },
];

export const ROUTER_BRAINS = [
  { id: "merged", label: "Jev + Panda", hint: "Both brains, blended" },
  { id: "jev", label: "Jev (System One)", hint: "Semantic task classification" },
  { id: "panda", label: "Panda", hint: "Calibrated success and cost ranking" },
];

export const COMPRESSION_LEVELS = [
  { id: "off", label: "Off", hint: "No compression" },
  { id: "lite", label: "Lite", hint: "Small saving" },
  { id: "full", label: "Full", hint: "Medium saving" },
  { id: "ultra", label: "Ultra", hint: "Maximum saving" },
];

export function getPreset(presetId) {
  return COMBO_STRATEGY_PRESETS.find((preset) => preset.id === presetId) || null;
}

// The settings a preset writes. "custom" writes nothing global.
export function presetSettingsPatch(presetId) {
  return getPreset(presetId)?.settings || {};
}

// The per-combo strategy a preset writes. "custom" has none - the user
// assembles it in the wizard.
export function presetComboStrategy(presetId) {
  return getPreset(presetId)?.comboStrategy || null;
}

// The compression levels of a preset, as the token saver stores them.
export function presetCompression(presetId) {
  const saver = getPreset(presetId)?.settings?.tokenSaver || {};
  return {
    rtkEnabled: saver.rtkEnabled === true,
    cavemanEnabled: saver.cavemanEnabled === true,
    cavemanLevel: saver.cavemanLevel || "off",
    ponytailEnabled: saver.ponytailEnabled === true,
    ponytailLevel: saver.ponytailLevel || "off",
    headroomEnabled: saver.headroomEnabled === true,
  };
}
