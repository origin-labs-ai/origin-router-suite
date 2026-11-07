// A2A protocol surface tests.
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((data, init) => ({ data, init, status: init?.status || 200 })),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));

const { buildAgentCard, sendMessage, getTask, cancelTask, taskStats } = await import("../../src/lib/a2a/index.js");
const { POST, GET } = await import("../../src/app/a2a/route.js");

function rpc(method, params = {}, id = 1) {
  return new Request("http://x/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("A2A agent card", () => {
  it("carries the three skills and honest capabilities", () => {
    const card = buildAgentCard({});
    expect(card.name).toBe("OriginRouter");
    expect(card.skills.map((s) => s.id)).toEqual(["smart-routing", "quota-management", "token-optimization"]);
    expect(card.capabilities.streaming).toBe(false); // honest until the pack adds it
  });

  it("well-known route serves the card", async () => {
    const res = await GET();
    expect(res.data.name).toBe("OriginRouter");
  });
});

describe("A2A task lifecycle", () => {
  it("message/send → submitted/working → completed with a routing plan", async () => {
    const res = await POST(rpc("message/send", { skill: "smart-routing", input: { strategy: "lkgp", seats: ["a/1", "b/2"], prompt: "hi" } }));
    const task = res.data.result.task;
    expect(task.id).toBeTruthy();
    expect(["submitted", "working", "completed"]).toContain(task.state);
    // Let the executor settle.
    await new Promise((r) => setTimeout(r, 30));
    const got = await POST(rpc("tasks/get", { id: task.id }));
    expect(got.data.result.task.state).toBe("completed");
    expect(got.data.result.task.result.seats).toHaveLength(2);
  });

  it("tasks/cancel fails a pending task", async () => {
    const res = await POST(rpc("message/send", { skill: "quota-management", input: {} }));
    const id = res.data.result.task.id;
    await POST(rpc("tasks/cancel", { id }));
    const got = await POST(rpc("tasks/get", { id }));
    expect(["failed", "completed"]).toContain(got.data.result.task.state);
  });

  it("unknown task errors -32602, unknown method -32601", async () => {
    expect((await POST(rpc("tasks/get", { id: "nope" }))).data.error.code).toBe(-32602);
    expect((await POST(rpc("bogus", {}))).data.error.code).toBe(-32601);
  });
});
