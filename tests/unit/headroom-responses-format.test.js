// #1998 — Headroom compression treated a Codex (openai-responses) body.input
// array as OpenAI messages: it sent Responses items to /v1/compress and then
// assigned the returned OpenAI messages back to body.input, violating the
// Responses format contract. body.input must stay Responses-shaped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Headroom always returns compressed OpenAI-style messages.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed text" }],
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    // body.input must remain Responses items (type:"message" + content array),
    // NOT the raw OpenAI messages ({ role, content: "<string>" }) the bug produced.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(typeof body.input[0].content).not.toBe("string");
  });

  it("compresses only the Responses tool output, leaving the rest of the history alone (#2132)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "tool", tool_call_id: "headroom-tool-0", content: "ok" }],
        tokens_saved: 10,
      }),
    }));

    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "investigate bug" }],
      },
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_apply_patch_123",
        output: "ok",
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
      },
    ];
    const body = {
      input: structuredClone(input),
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).not.toBeNull();
    // Only the plain-text tool output is projected for compression — the user
    // message, the tool call and the reasoning item stay in body.input.
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.messages).toEqual([{ role: "tool", tool_call_id: "headroom-tool-0", content: "ok" }]);
    // body.input keeps the Responses contract: the items are untouched.
    expect(body.input).toEqual(input);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(body.input[3]).toMatchObject({ type: "reasoning" });
  });

  it("skips Responses tool/reasoning history that has no compressible tool output (#2132)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed tool history" }],
        tokens_saved: 10,
      }),
    }));

    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "investigate bug" }],
      },
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
      },
    ];
    const body = { input: structuredClone(input) };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body.input).toEqual(input);
    // No function_call_output leaf to compress → nothing is sent to the proxy.
    expect(diagnostics.reason).toBe("no eligible plain-text tool output");
  });
});
