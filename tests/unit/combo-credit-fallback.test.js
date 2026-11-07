import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("combo credit fallback", () => {
  it.each([
    ["You have insufficient credits to make this request.", true],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", true],
    // A generic 400 matches no ERROR_RULES entry, so checkFallbackError() reports it as
    // request-scoped: the credential is healthy, only this member could not serve the
    // request. The combo therefore advances to the next member as well.
    ["Bad request", true],
  ])("routes a 400 response correctly: %s", async (message, shouldContinue) => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message } }, { status: 400 });
    const success = Response.json({ choices: [{ message: { content: "Hello" } }] });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body, models, handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback", comboStrategy: "fallback",
    });

    expect(response).toBe(shouldContinue ? success : failure);
    expect(handleSingleModel.mock.calls).toEqual(
      (shouldContinue ? models : models.slice(0, 1)).map((model) => [body, model])
    );
  });

  it("returns the first request-scoped failure when no member can serve the request", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const first = Response.json({ error: { message: "Bad request" } }, { status: 400 });
    const second = Response.json({ error: { message: "Bad request" } }, { status: 400 });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const response = await handleComboChat({
      body, models, handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback", comboStrategy: "fallback",
    });

    // The synthesized envelope would reach the client as a 200 carrying an error
    // object; the member that named the real cause is handed back instead.
    expect(response).toBe(first);
    expect(handleSingleModel.mock.calls).toEqual(models.map((model) => [body, model]));
  });
});
