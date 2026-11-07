// Reasoning state preservation tests.
import { describe, it, expect } from "vitest";
import {
  captureReasoning,
  replayReasoning,
  reasoningStats,
  clearReasoningState,
} from "../../open-sse/harness/reasoningState.js";

const RESPONSE_WITH_TOOL = {
  choices: [{
    message: {
      role: "assistant",
      content: "",
      reasoning_content: "I should search the parser module for the bug.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "grep", arguments: "{}" } }],
    },
  }],
};

describe("reasoning state", () => {
  it("captures reasoning keyed by tool_call id", () => {
    clearReasoningState();
    captureReasoning({ model: "deepseek-r2", response: RESPONSE_WITH_TOOL });
    const stats = reasoningStats();
    expect(stats.entries).toBeGreaterThanOrEqual(1);
  });

  it("replays reasoning onto the assistant turn before the tool result", () => {
    clearReasoningState();
    captureReasoning({ model: "deepseek-r2", response: RESPONSE_WITH_TOOL });
    const messages = [
      { role: "user", content: "find the bug" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "no match" },
      { role: "user", content: "continue" },
    ];
    const { messages: out } = replayReasoning({ model: "deepseek-r2", messages });
    expect(out).not.toBe(messages); // augmented copy
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("I should search the parser module for the bug.");
  });

  it("replay for another model returns the same array untouched", () => {
    clearReasoningState();
    captureReasoning({ model: "deepseek-r2", response: RESPONSE_WITH_TOOL });
    const messages = [
      { role: "assistant", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: "x" },
    ];
    const { messages: out } = replayReasoning({ model: "other-model", messages });
    expect(out).toBe(messages);
  });

  it("never injects into an assistant turn that already has reasoning", () => {
    clearReasoningState();
    captureReasoning({ model: "m1", response: RESPONSE_WITH_TOOL });
    const messages = [
      { role: "assistant", content: "", reasoning_content: "original", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: "x" },
    ];
    const { messages: out } = replayReasoning({ model: "m1", messages });
    expect(out.find((m) => m.role === "assistant").reasoning_content).toBe("original");
  });

  it("fails open on garbage input", () => {
    expect(replayReasoning({}).messages).toEqual([]);
    expect(captureReasoning({ response: null })).toBeUndefined();
  });
});
