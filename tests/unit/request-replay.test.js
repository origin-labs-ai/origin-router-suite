// Replaying a logged request has to rebuild the request the router was actually
// asked for, and refuse the ones it cannot rebuild. The rules are pure, so
// they are checked here without a database and without a network.
import { describe, it, expect } from "vitest";
import { buildReplayRequest, summarizeReplay } from "../../src/lib/requestReplay.js";

// A row as the request log writes it: the OpenAI-shaped body the router
// forwarded upstream, next to the metadata of the row.
const chatRecord = (overrides = {}) => ({
  id: "req-1",
  timestamp: "2026-11-06T10:00:00.000Z",
  provider: "openai",
  model: "gpt-5",
  connectionId: "conn-1",
  status: "success",
  request: {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    model: "openai/gpt-5",
    stream: false,
    temperature: 0.4,
  },
  ...overrides,
});

describe("buildReplayRequest", () => {
  it("rebuilds a chat request that can be sent again", () => {
    const replay = buildReplayRequest(chatRecord());

    expect(replay.replayable).toBe(true);
    expect(replay.endpoint).toBe("/v1/chat/completions");
    expect(replay.method).toBe("POST");
    expect(replay.model).toBe("openai/gpt-5");
    expect(replay.body.messages).toHaveLength(2);
    expect(replay.body.messages[0]).toEqual({ role: "user", content: "hello" });
    // The parameters the caller had chosen are part of the request.
    expect(replay.body.temperature).toBe(0.4);
    expect(replay.headers["Content-Type"]).toBe("application/json");
    expect(replay.description).toContain("openai/gpt-5");
  });

  it("sends no credential of its own", () => {
    const replay = buildReplayRequest(chatRecord());

    const headerNames = Object.keys(replay.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("x-api-key");
  });

  it("refuses a request whose body was never stored", () => {
    const replay = buildReplayRequest(chatRecord({ request: undefined }));

    expect(replay.replayable).toBe(false);
    expect(replay.reason).toMatch(/no request body/i);
    expect(replay.body).toBeUndefined();
  });

  it("refuses a body that is not JSON", () => {
    const replay = buildReplayRequest(chatRecord({ request: "{not json" }));

    expect(replay.replayable).toBe(false);
    expect(replay.reason).toMatch(/not valid json/i);
  });

  it("refuses a body that was truncated when it was logged", () => {
    const replay = buildReplayRequest(chatRecord({
      request: { _truncated: true, _originalSize: 90000, _preview: "…" },
    }));

    expect(replay.replayable).toBe(false);
    expect(replay.reason).toMatch(/truncated/i);
  });

  it("refuses a request without messages to replay", () => {
    const replay = buildReplayRequest(chatRecord({ request: { model: "openai/gpt-5" } }));

    expect(replay.replayable).toBe(false);
    expect(replay.reason).toMatch(/no messages/i);
  });

  it("picks the model up from the stored request", () => {
    const replay = buildReplayRequest(chatRecord());

    expect(replay.model).toBe("openai/gpt-5");
    expect(replay.body.model).toBe("openai/gpt-5");
  });

  it("falls back to the provider and model of the row when the body has none", () => {
    const record = chatRecord();
    delete record.request.model;

    const replay = buildReplayRequest(record);

    expect(replay.replayable).toBe(true);
    expect(replay.model).toBe("openai/gpt-5");
  });

  it("replays a streamed request without streaming", () => {
    const record = chatRecord();
    record.request.stream = true;

    const replay = buildReplayRequest(record);

    expect(replay.replayable).toBe(true);
    // A streamed answer arrives in pieces, so there would be no body to preview.
    expect(replay.body.stream).toBe(false);
    expect(replay.description).toMatch(/streamed/i);
  });

  it("reads a body that was stored as raw JSON text", () => {
    const replay = buildReplayRequest(chatRecord({
      request: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        model: "openai/gpt-5",
      }),
    }));

    expect(replay.replayable).toBe(true);
    expect(replay.body.messages).toHaveLength(1);
  });

  it("does not carry a logged client header into the body", () => {
    const record = chatRecord();
    record.request.headers = { "content-type": "application/json" };

    const replay = buildReplayRequest(record);

    expect(replay.body.headers).toBeUndefined();
    expect(replay.headers["Content-Type"]).toBe("application/json");
  });

  it("refuses a record that is not a request at all", () => {
    const replay = buildReplayRequest(null);

    expect(replay.replayable).toBe(false);
    expect(replay.reason).toMatch(/no stored request/i);
  });
});

describe("summarizeReplay", () => {
  it("describes a stored request and whether it can be replayed", () => {
    const summary = summarizeReplay(chatRecord());

    expect(summary.id).toBe("req-1");
    expect(summary.provider).toBe("openai");
    expect(summary.model).toBe("openai/gpt-5");
    expect(summary.status).toBe("success");
    expect(summary.endpoint).toBe("/v1/chat/completions");
    expect(summary.method).toBe("POST");
    expect(summary.messageCount).toBe(2);
    expect(summary.streaming).toBe(false);
    expect(summary.replayable).toBe(true);
    expect(summary.reason).toBeNull();
  });

  it("reports why a request cannot be replayed", () => {
    const summary = summarizeReplay(chatRecord({ request: undefined }));

    expect(summary.replayable).toBe(false);
    expect(summary.reason).toMatch(/no request body/i);
    expect(summary.messageCount).toBe(0);
  });

  it("survives a missing record", () => {
    const summary = summarizeReplay(undefined);

    expect(summary.replayable).toBe(false);
    expect(summary.reason).toMatch(/no stored request/i);
  });
});
