// A dashboard model test must answer one honest question: did THIS provider serve
// THIS model id? The router's promise that a client never sees an upstream error is
// for agent traffic (Claude Code, CLIs) and must not turn a refused or missing model
// into a green checkmark. Three things enforce that, and all three can regress:
//   1. the ping marks itself as a strict test request;
//   2. a router-synthesized last-resort completion is reported as a failure;
//   3. a timeout is a separate verdict from an error, so a slow seat is rechecked
//      instead of deleted.
//
// ping.js pulls in Next.js-only deps (@/lib/localDb, config, machineId), so those are
// mocked here exactly as in ping-reasoning-models-3010.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LAST_RESORT_TEXT } from "open-sse/utils/lastResortText.js";
import { describeModelTest } from "@/shared/utils/modelTestStatus";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "test-key", isActive: true }]) }));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token") }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");

const BASE = "http://127.0.0.1:20127";

function chatResponse(payload) {
  return {
    ok: payload.__status === undefined,
    status: payload.__status ?? 200,
    text: async () => {
      const { __status, ...rest } = payload;
      return JSON.stringify(rest);
    },
  };
}

describe("model test honesty", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks the probe as a strict model test so the router cannot mask an error", async () => {
    fetchMock.mockResolvedValue(chatResponse({ choices: [{ message: { content: "Hi!" } }] }));

    await pingModelByKind("openai/gpt-4o", "llm", BASE);

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["x-or-model-test"]).toBe("1");
  });

  it("reports the router's synthesized last-resort completion as a failure", async () => {
    // Exactly what a build with lastResort="respond" returns when nothing served
    // the model: HTTP 200, a valid envelope, and this sentence in the content.
    fetchMock.mockResolvedValue(chatResponse({
      model: "openai/gpt-4o",
      choices: [{ finish_reason: "stop", message: { content: LAST_RESORT_TEXT } }],
    }));

    const result = await pingModelByKind("openai/gpt-4o", "llm", BASE);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/synthesized/i);
  });

  it("reports an empty completion as a failure", async () => {
    fetchMock.mockResolvedValue(chatResponse({
      choices: [{ finish_reason: "stop", message: { content: "" } }],
    }));

    const result = await pingModelByKind("some/model", "llm", BASE);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty completion/i);
  });

  it("passes a real answer and names the model that answered", async () => {
    fetchMock.mockResolvedValue(chatResponse({
      model: "gpt-4o",
      choices: [{ finish_reason: "stop", message: { content: "Hello there!" } }],
    }));

    const result = await pingModelByKind("openai/gpt-4o", "llm", BASE);

    expect(result.ok).toBe(true);
    expect(result.answeredModel).toBe("gpt-4o");
    expect(result.note).toBeUndefined();
  });

  it("says who answered when the reply came from a different model id", async () => {
    fetchMock.mockResolvedValue(chatResponse({
      model: "gpt-4o-mini",
      choices: [{ finish_reason: "stop", message: { content: "Hello!" } }],
    }));

    const result = await pingModelByKind("openai/gpt-4o", "llm", BASE);

    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/answered by: gpt-4o-mini/);
  });

  it("surfaces an upstream refusal instead of masking it", async () => {
    fetchMock.mockResolvedValue(chatResponse({
      __status: 404,
      error: { message: `The model \`jhgsdca\` does not exist or you do not have access to it.` },
    }));

    const result = await pingModelByKind("openai/jhgsdca", "llm", BASE);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toMatch(/does not exist/);
    expect(result.timedOut).toBeUndefined();
  });

  it("classifies a timeout as a recheck, not as a broken model", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    );

    const result = await pingModelByKind("slow/model", "llm", BASE);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toMatch(/recheck/i);
  });
});

describe("describeModelTest verdict mapping", () => {
  it("keeps timeout separate from error so the UI never deletes a slow seat", () => {
    expect(describeModelTest({ ok: true, latencyMs: 812 }).status).toBe("ok");
    expect(describeModelTest({ ok: false, timedOut: true, latencyMs: 15000, error: "Timed out after 15s (llm) — recheck, this is not a refusal" }).status).toBe("timeout");
    expect(describeModelTest({ ok: false, status: 404, error: "HTTP 404: model_not_found" }).status).toBe("error");
  });

  it("shows who answered when the ping reports a mismatch", () => {
    const { status, detail } = describeModelTest({ ok: true, latencyMs: 900, note: "answered by: gpt-4o-mini" });
    expect(status).toBe("ok");
    expect(detail).toContain("answered by: gpt-4o-mini");
  });
});
