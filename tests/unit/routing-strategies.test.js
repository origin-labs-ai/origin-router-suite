// The strategy registry is the single source of truth for routing strategies.
// The engine dispatches by these ids; the wizard renders this list.
import { describe, it, expect } from "vitest";
import {
  ROUTING_STRATEGIES,
  STRATEGY_IDS,
  normalizeStrategy,
  listStrategies,
  getStrategy,
  isPanelStrategy,
} from "../../src/lib/routing/strategies.js";
import {
  orderSeats,
  recordComboOutcome,
  getSeatStatsSnapshot,
} from "../../open-sse/services/comboOrderers.js";

describe("routing strategy registry", () => {
  it("exposes exactly 24 strategies", () => {
    expect(STRATEGY_IDS).toHaveLength(24);
    expect(new Set(STRATEGY_IDS).size).toBe(24);
  });

  it("normalizes legacy and alternate names", () => {
    expect(normalizeStrategy("priority")).toBe("fallback");
    expect(normalizeStrategy("usage")).toBe("least-used");
    expect(normalizeStrategy("cheapest")).toBe("cost-optimized");
    expect(normalizeStrategy("max")).toBe("smart");
    expect(normalizeStrategy("mythos")).toBe("smart");
    expect(normalizeStrategy("aggressive")).toBe("autoaggressive");
    expect(normalizeStrategy("nonsense")).toBe("fallback");
    expect(normalizeStrategy("")).toBe("fallback");
  });

  it("classifies kinds correctly", () => {
    expect(isPanelStrategy("fusion")).toBe(true);
    expect(isPanelStrategy("pipeline")).toBe(true);
    expect(getStrategy("smart").kind).toBe("brain");
    expect(getStrategy("p2c").kind).toBe("orderer");
  });

  it("listStrategies returns UI-safe metadata", () => {
    const list = listStrategies();
    expect(list).toHaveLength(24);
    for (const s of list) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(["orderer", "panel", "brain"]).toContain(s.kind);
    }
  });
});

describe("combo orderers", () => {
  const seats = ["openai/gpt-a", "anthropic/claude-b", "gemini/gemini-c"];

  it("passes fallback through unchanged", () => {
    expect(orderSeats(seats, "fallback", {})).toEqual(seats);
  });

  it("least-used puts the never-picked seat first, stable", () => {
    recordComboOutcome(seats[1], { comboName: "t1" }, { ok: true });
    recordComboOutcome(seats[1], { comboName: "t1" }, { ok: true });
    const order = orderSeats(seats, "least-used", { comboName: "t1" });
    expect(order[0]).toBe(seats[0]);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(seats));
  });

  it("lkgp promotes the seat that succeeded last", () => {
    recordComboOutcome(seats[2], { comboName: "t2" }, { ok: true });
    const order = orderSeats(seats, "lkgp", { comboName: "t2" });
    expect(order[0]).toBe(seats[2]);
  });

  it("cost-optimized sorts free seats ahead of priced ones", () => {
    const order = orderSeats(seats, "cost-optimized", { comboName: "t3" });
    expect(order).toHaveLength(3);
  });

  it("strict-random returns a permutation and drains the deck", () => {
    const a = orderSeats(seats, "strict-random", { comboName: "t4" });
    const b = orderSeats(seats, "strict-random", { comboName: "t4" });
    const c = orderSeats(seats, "strict-random", { comboName: "t4" });
    for (const order of [a, b, c]) {
      expect(order).toHaveLength(3);
      expect(new Set(order)).toEqual(new Set(seats));
    }
    // Three draws from a 3-seat deck must have used three distinct heads.
    expect(new Set([a[0], b[0], c[0]]).size).toBe(3);
  });

  it("quota family fails open to a permutation without a quota source", () => {
    for (const strategy of ["reset-aware", "reset-window", "headroom", "quota-weighted", "expiry-first"]) {
      const order = orderSeats(seats, strategy, { comboName: "t5" });
      expect(order).toHaveLength(3);
      expect(new Set(order)).toEqual(new Set(seats));
    }
  });

  it("weighted respects configured weights and ignores empty ones", () => {
    expect(orderSeats(seats, "weighted", { comboName: "t6", weights: {} })).toEqual(seats);
    const order = orderSeats(seats, "weighted", { comboName: "t6", weights: { [seats[1]]: 10 } });
    expect(order[0]).toBe(seats[1]);
  });

  it("stats snapshot is JSON-safe", () => {
    recordComboOutcome(seats[0], { comboName: "t7" }, { ok: true, status: 200, firstByteMs: 120 });
    const snap = getSeatStatsSnapshot("t7");
    expect(snap[seats[0]].ok).toBe(1);
    expect(snap[seats[0]].health).toBe(1);
    expect(JSON.parse(JSON.stringify(snap))).toBeTruthy();
  });
});
