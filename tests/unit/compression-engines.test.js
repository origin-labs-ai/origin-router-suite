// Compression engine registry + gates tests.
import { describe, it, expect } from "vitest";
import { registerEngine, unregisterEngine, listEngines } from "../../open-sse/compression/registry.js";
import { fidelityOk, applyRiskShield, removeRiskShield, isExcluded, setCompressionExclusions, runCompressionPipeline } from "../../open-sse/compression/gates.js";

const dupBody = [
  { role: "user", content: "run the tests" },
  { role: "tool", tool_call_id: "c1", content: "all 42 passed" },
  { role: "tool", tool_call_id: "c1", content: "all 42 passed" },
  { role: "assistant", content: "ok" },
];

describe("built-in engines", () => {
  it("session-dedup collapses identical consecutive tool results", async () => {
    const { runCompressionPipeline: run } = await import("../../open-sse/compression/gates.js");
    const { messages, applied } = run({ messages: dupBody, provider: "x", model: "y" });
    expect(applied).toContain("session-dedup");
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("lite strips trailing whitespace before newlines", async () => {
    const { runCompressionPipeline: run } = await import("../../open-sse/compression/gates.js");
    const { messages, applied } = run({ messages: [{ role: "user", content: "code:   \nnext" }], provider: "x", model: "y" });
    expect(applied).toContain("lite");
    expect(messages[0].content).toBe("code:\nnext");
  });

  it("registry list is priority-ordered and plugin-friendly", () => {
    registerEngine({ id: "zz-test", stackPriority: 90, apply: (m) => m });
    const ids = listEngines().map((e) => e.id);
    expect(ids.indexOf("session-dedup")).toBeLessThan(ids.indexOf("zz-test"));
    unregisterEngine("zz-test");
    expect(listEngines().some((e) => e.id === "zz-test")).toBe(false);
  });
});

describe("gates", () => {
  it("fidelity gate refuses a step that loses a tool_call id", () => {
    const before = [{ role: "assistant", content: "", tool_calls: [{ id: "keep-me" }] }];
    const after = [{ role: "assistant", content: "" }];
    expect(fidelityOk(before, after)).toBe(false);
  });

  it("fidelity gate allows a legitimate dedup (role subsequence)", () => {
    expect(fidelityOk(dupBody, [dupBody[0], dupBody[1], dupBody[3]])).toBe(true);
  });

  it("risk shield masks and restores credential spans", () => {
    const { messages, shielded } = applyRiskShield([{ role: "user", content: "key is sk-abcdef1234567890abcdef ok" }]);
    expect(shielded).toBe(1);
    expect(messages[0].content).not.toContain("sk-abcdef");
    const restored = removeRiskShield(messages);
    expect(restored[0].content).toContain("sk-abcdef1234567890abcdef");
  });

  it("exclusions skip engines for matching models", () => {
    setCompressionExclusions(["openai/gpt-5::session-dedup"]);
    expect(isExcluded("openai", "gpt-5", "session-dedup")).toBe(true);
    expect(isExcluded("openai", "gpt-5", "lite")).toBe(false);
    setCompressionExclusions([]);
  });

  it("pipeline reports saved bytes", () => {
    const { savedBytes } = runCompressionPipeline({ messages: dupBody, provider: "x", model: "y" });
    expect(savedBytes).toBeGreaterThan(0);
  });
});
