// The three routing presets the wizard offers. They write into the real
// settings, so the values have to stay inside what the router accepts.
import { describe, it, expect } from "vitest";
import {
  COMBO_STRATEGY_PRESETS,
  getPreset,
  presetComboStrategy,
  presetCompression,
  presetSettingsPatch,
} from "../../src/lib/onboardingPresets.js";

describe("onboarding presets", () => {
  it("offers exactly three choices", () => {
    expect(COMBO_STRATEGY_PRESETS.map((preset) => preset.id)).toEqual([
      "max",
      "revolt-deffusion",
      "custom",
    ]);
  });

  it("maxes everything out", () => {
    const patch = presetSettingsPatch("max");
    expect(patch.routingPolicy.routerBrain ?? "merged").toBe("merged");
    expect(patch.routingPolicy.maxAgentsConcurrency).toBe(64);
    expect(patch.routingPolicy.perConnectionConcurrency).toBe(64);
    expect(patch.routingPolicy.maxFailoverRoutes).toBe(64);
    expect(patch.routingPolicy.seatFairness).toBe(1);
    expect(patch.tokenSaver.cavemanLevel).toBe("ultra");
    expect(patch.tokenSaver.ponytailLevel).toBe("ultra");
    expect(patch.tokenSaver.rtkEnabled).toBe(true);

    const strategy = presetComboStrategy("max");
    expect(strategy.routerBrain).toBe("merged");
    expect(strategy.fallbackStrategy).toBe("smart");
  });

  it("keeps the compression in the middle for RevoltDeffusion", () => {
    const patch = presetSettingsPatch("revolt-deffusion");
    expect(patch.tokenSaver.cavemanLevel).toBe("full");
    expect(patch.tokenSaver.ponytailLevel).toBe("full");
    expect(patch.tokenSaver.headroomEnabled).toBe(false);
    // The brain is still both of them.
    expect(presetComboStrategy("revolt-deffusion").routerBrain).toBe("merged");
    // The concurrency is left alone.
    expect(patch.routingPolicy.maxAgentsConcurrency).toBeUndefined();
  });

  it("writes nothing behind the user's back for the custom choice", () => {
    expect(presetSettingsPatch("custom")).toEqual({});
    expect(presetComboStrategy("custom")).toBeNull();
  });

  it("keeps every preset inside the limits the router clamps to", () => {
    for (const preset of COMBO_STRATEGY_PRESETS) {
      const policy = preset.settings?.routingPolicy || {};
      if (policy.maxAgentsConcurrency !== undefined) {
        expect(policy.maxAgentsConcurrency).toBeLessThanOrEqual(64);
        expect(policy.maxAgentsConcurrency).toBeGreaterThanOrEqual(1);
      }
      if (policy.admissionQueueMs !== undefined) {
        expect(policy.admissionQueueMs).toBeLessThanOrEqual(120000);
      }
      if (policy.hedgeMs !== undefined) {
        expect(policy.hedgeMs).toBeLessThanOrEqual(120000);
      }
      if (policy.brainTimeoutMs !== undefined) {
        expect(policy.brainTimeoutMs).toBeLessThanOrEqual(60000);
      }
      if (policy.seatFairness !== undefined) {
        expect(policy.seatFairness).toBeLessThanOrEqual(1);
        expect(policy.seatFairness).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reads the compression of a preset", () => {
    expect(presetCompression("max").cavemanLevel).toBe("ultra");
    expect(presetCompression("revolt-deffusion").cavemanLevel).toBe("full");
    expect(presetCompression("custom").cavemanEnabled).toBe(false);
  });

  it("does not know presets it never heard of", () => {
    expect(getPreset("nope")).toBeNull();
    expect(presetSettingsPatch("nope")).toEqual({});
  });
});
