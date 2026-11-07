// MCP JSON-RPC server surface tests.
import { describe, it, expect, vi } from "vitest";

// The route file imports NextResponse — mock next/server like the other tests do.
const mocks = vi.hoisted(() => ({
  json: vi.fn((data, init) => ({ data, init, status: init?.status || 200 })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.json,
  },
}));

// Suppress the heavy import graph failures if any — the route pulls the
// registry + fold + harness which are all importable in tests.
const { POST, GET } = await import("../../src/app/api/mcp/route.js");

function rpc(method, params = {}, id = 1) {
  return new Request("http://x/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("MCP JSON-RPC surface", () => {
  it("initialize returns protocol + serverInfo", async () => {
    const res = await POST(rpc("initialize", {}));
    expect(res.data.result.protocolVersion).toBeTruthy();
    expect(res.data.result.serverInfo.name).toBe("origin-router");
  });

  it("tools/list exposes six tools", async () => {
    const res = await POST(rpc("tools/list", {}));
    const tools = res.data.result.tools;
    expect(tools).toHaveLength(6);
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description.length).toBeLessThanOrEqual(200);
    }
  });

  it("tools/call strategy_list returns 24 strategies", async () => {
    const res = await POST(rpc("tools/call", { name: "strategy_list", arguments: {} }));
    const inner = JSON.parse(res.data.result.content[0].text);
    expect(inner.strategies).toHaveLength(24);
  });

  it("tools/call routing_plan orders explicit seats and stays a permutation", async () => {
    const res = await POST(rpc("tools/call", {
      name: "routing_plan",
      arguments: { strategy: "least-used", seats: ["a/m1", "b/m2", "c/m3"], prompt: "x" },
    }));
    const inner = JSON.parse(res.data.result.content[0].text);
    expect(inner.seats).toHaveLength(3);
    expect(new Set(inner.seats)).toEqual(new Set(["a/m1", "b/m2", "c/m3"]));
  });

  it("unknown tool errors with -32602", async () => {
    const res = await POST(rpc("tools/call", { name: "nope" }));
    expect(res.data.error.code).toBe(-32602);
  });

  it("unknown method errors with -32601", async () => {
    const res = await POST(rpc("method", {})); 
    expect(res.data.error.code).toBe(-32601);
  });

  it("GET describes the surface", async () => {
    const res = await GET();
    expect(res.data.tools).toContain("routing_plan");
  });
});
