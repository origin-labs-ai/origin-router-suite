// Provider health turns requests + connections into "is this provider
// working?". The rules are worth testing without a database.
import { describe, it, expect } from "vitest";
import { buildProviderHealth, summarizeHealth } from "../../src/lib/providerHealth.js";

const NOW = new Date(2026, 10, 15, 12, 0, 0); // 15 November 2026, local time

// Minutes ago -> ISO timestamp.
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();

const connection = (provider, overrides = {}) => ({
  id: `${provider}-1`,
  provider,
  name: "Account 1",
  isActive: true,
  testStatus: "active",
  ...overrides,
});

const ok = (provider, minutesAgo) => ({
  provider,
  status: "ok",
  timestamp: at(minutesAgo),
});

const fail = (provider, minutesAgo, error) => ({
  provider,
  status: "error",
  timestamp: at(minutesAgo),
  error,
});

// `count` rows, oldest first, starting `startMinutesAgo` minutes back.
const many = (provider, count, status = "ok", startMinutesAgo = 20) =>
  Array.from({ length: count }, (_, i) => ({
    provider,
    status,
    timestamp: at(startMinutesAgo + i),
  }));

describe("provider health", () => {
  it("calls a provider with successes and no failures healthy", () => {
    const health = buildProviderHealth(
      [connection("openai")],
      [ok("openai", 5), ok("openai", 10), ok("openai", 15)],
      { now: NOW },
    );

    expect(health).toHaveLength(1);
    expect(health[0].provider).toBe("openai");
    expect(health[0].status).toBe("healthy");
    expect(health[0].requests).toBe(3);
    expect(health[0].errors).toBe(0);
    expect(health[0].errorRate).toBe(0);
    expect(health[0].lastUsedAt).toBe(at(5));
    expect(health[0].connections).toHaveLength(1);
    expect(health[0].connections[0].status).toBe("ok");
  });

  it("calls a provider degraded once the error rate passes 5%", () => {
    // 18 successes + 2 failures = 10% failures. Both failures are older than
    // the last 10 requests, so only the error rate can make this degraded.
    const rows = [
      ...many("groq", 18, "ok", 5),
      fail("groq", 25, "502 bad gateway"),
      fail("groq", 26, "502 bad gateway"),
    ];

    const health = buildProviderHealth([connection("groq")], rows, { now: NOW });

    expect(health[0].status).toBe("degraded");
    expect(health[0].requests).toBe(20);
    expect(health[0].errors).toBe(2);
    expect(health[0].errorRate).toBeCloseTo(0.1, 4);
  });

  it("calls a provider degraded when one of the last 10 requests failed", () => {
    // 19 successes + 1 failure = exactly 5%, which is not above the threshold.
    // The failure is the newest request, so the provider is acting up now.
    const rows = [fail("groq", 5, "429 rate limited"), ...many("groq", 19, "ok", 10)];

    const health = buildProviderHealth([connection("groq")], rows, { now: NOW });

    expect(health[0].errorRate).toBe(0.05);
    expect(health[0].status).toBe("degraded");
    expect(health[0].lastError).toBe("429 rate limited");
  });

  it("calls a provider down when every request failed and every connection is broken", () => {
    const connections = [
      connection("codex", { testStatus: "unavailable", lastError: "401 unauthorized" }),
      connection("codex", {
        id: "codex-2",
        name: "Account 2",
        testStatus: "unavailable",
        lastError: "401 unauthorized",
      }),
    ];

    const health = buildProviderHealth(
      connections,
      [fail("codex", 5, "401 unauthorized"), fail("codex", 8, "401 unauthorized")],
      { now: NOW },
    );

    expect(health[0].status).toBe("down");
    expect(health[0].requests).toBe(2);
    expect(health[0].errors).toBe(2);
    expect(health[0].connections.every((c) => c.status === "error")).toBe(true);
    expect(health[0].lastError).toBe("401 unauthorized");
  });

  it("keeps a provider degraded - not down - while one connection still works", () => {
    const connections = [
      connection("codex", { testStatus: "unavailable", lastError: "401 unauthorized" }),
      connection("codex", { id: "codex-2", name: "Account 2", testStatus: "active" }),
    ];

    const health = buildProviderHealth(connections, [fail("codex", 5, "401 unauthorized")], { now: NOW });

    expect(health[0].status).toBe("degraded");
  });

  it("calls a locked connection down when every request failed", () => {
    const connections = [
      connection("kiro", { testStatus: "active", modelLock_gpt: at(-5) }), // lock still running
    ];

    const health = buildProviderHealth(connections, [fail("kiro", 5, "429")], { now: NOW });

    expect(health[0].connections[0].status).toBe("locked");
    expect(health[0].status).toBe("down");
  });

  it("calls a configured provider idle when it was never used in the window", () => {
    const health = buildProviderHealth([connection("kiro")], [], { now: NOW });

    expect(health).toHaveLength(1);
    expect(health[0].status).toBe("idle");
    expect(health[0].requests).toBe(0);
    expect(health[0].lastUsedAt).toBeNull();
    expect(health[0].lastError).toBeNull();
  });

  it("calls a provider unknown when nothing is known about it", () => {
    const health = buildProviderHealth([], [], { providers: ["gemini"], now: NOW });

    expect(health).toHaveLength(1);
    expect(health[0].provider).toBe("gemini");
    expect(health[0].status).toBe("unknown");
    expect(health[0].requests).toBe(0);
  });

  it("does the error rate maths", () => {
    const health = buildProviderHealth(
      [connection("openai")],
      [ok("openai", 5), ok("openai", 10), fail("openai", 15, "boom")],
      { now: NOW },
    );

    expect(health[0].requests).toBe(3);
    expect(health[0].errors).toBe(1);
    expect(health[0].errorRate).toBeCloseTo(1 / 3, 4);
  });

  it("averages the latency samples and keeps a p95", () => {
    const health = buildProviderHealth(
      [connection("openai")],
      [ok("openai", 5)],
      { latencies: { openai: [100, 200, 300] }, now: NOW },
    );

    expect(health[0].avgLatencyMs).toBe(200);
    expect(health[0].p95LatencyMs).toBe(300);
  });

  it("has no latency numbers when no sample was collected", () => {
    const health = buildProviderHealth([connection("openai")], [ok("openai", 5)], { now: NOW });

    expect(health[0].avgLatencyMs).toBeNull();
    expect(health[0].p95LatencyMs).toBeNull();
  });

  it("counts the providers per state", () => {
    const connections = [
      connection("openai"),
      connection("groq"),
      connection("kiro"),
      connection("codex", { testStatus: "unavailable", lastError: "401 unauthorized" }),
    ];
    const rows = [
      ok("openai", 5),
      fail("groq", 5, "boom"),
      fail("codex", 5, "401 unauthorized"),
    ];

    const health = buildProviderHealth(connections, rows, { providers: ["gemini"], now: NOW });
    const summary = summarizeHealth(health);

    expect(health.map((entry) => entry.status)).toEqual(["down", "degraded", "healthy", "idle", "unknown"]);
    expect(summary.healthy).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(summary.down).toBe(1);
    expect(summary.idle).toBe(1);
    expect(summary.unknown).toBe(1);
    expect(summary.total).toBe(5);
  });

  it("survives empty input", () => {
    expect(buildProviderHealth([], [])).toEqual([]);
    expect(summarizeHealth([])).toEqual({
      healthy: 0,
      degraded: 0,
      down: 0,
      idle: 0,
      unknown: 0,
      total: 0,
    });
  });
});
