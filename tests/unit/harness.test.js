// Provider Adapter Harness tests — the deterministic `complete()` contract.
import { describe, it, expect, vi } from "vitest";
import {
  createProviderAdapter,
  provideAdapter,
  getAdapter,
  listAdapters,
} from "../../open-sse/harness/index.js";

describe("provider adapter harness", () => {
  it("openai adapter posts to {base}/chat/completions with bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const adapter = createProviderAdapter({ providerId: "acme", kind: "openai", baseUrl: "https://api.acme.dev/v1", apiKey: "k", fetchImpl });
    const out = await adapter.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(out.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.acme.dev/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body).stream).toBe(false);
  });

  it("anthropic adapter posts to {base}/messages with x-api-key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "msg" }), { status: 200 }));
    const adapter = createProviderAdapter({ providerId: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k", fetchImpl });
    await adapter.complete({ model: "claude-fable-5-1", messages: [{ role: "user", content: "hi" }] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url.endsWith("/messages")).toBe(true);
    expect(init.headers["x-api-key"]).toBe("k");
    expect(init.headers["anthropic-version"]).toBeTruthy();
  });

  it("gemini adapter refuses non-https and hits generateContent with ?key=", async () => {
    const adapter = createProviderAdapter({ providerId: "gemini", kind: "gemini", baseUrl: "http://x", apiKey: "k" });
    await expect(adapter.complete({ model: "gemini-3" })).rejects.toThrow(/https/);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const okAdapter = createProviderAdapter({ providerId: "g2", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "k", fetchImpl });
    await okAdapter.complete({ model: "models/gemini-3", messages: [{ role: "user", content: "hi" }] });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain(":generateContent");
    expect(url).toContain("key=");
  });

  it("unknown kind falls back to openai", () => {
    const adapter = createProviderAdapter({ providerId: "x", kind: "quantum", baseUrl: "https://x.dev/v1", apiKey: "k" });
    expect(adapter.kind).toBe("openai");
  });

  it("registry: provideAdapter registers, getAdapter/listAdapters read", () => {
    const a = provideAdapter({ providerId: "reg-1", kind: "openai", baseUrl: "https://x.dev/v1", apiKey: "k" });
    expect(getAdapter("reg-1").id).toBe("reg-1");
    expect(listAdapters().find((x) => x.id === "reg-1").kind).toBe("openai");
    expect(a.complete).toBeTypeOf("function");
  });
});
