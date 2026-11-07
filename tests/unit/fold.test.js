// OriginFold — conversation fold layer tests.
import { describe, it, expect } from "vitest";
import {
  processTurn,
  resolveFoldConfig,
  estimateTokens,
  executeFoldTool,
  FOLD_TOOL_SCHEMAS,
} from "../../open-sse/fold/index.js";

function bigBody(turns) {
  const messages = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Start working on the parser module." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `Turn ${i}: ${"lorem ipsum ".repeat(1200)}` });
    messages.push({ role: "assistant", content: `Reply ${i}: ${"dolor sit amet ".repeat(1200) }` });
  }
  return { messages, stream: false };
}

describe("OriginFold", () => {
  it("leaves tiny conversations untouched", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const r = processTurn({ body, provider: "openai", model: "gpt-5", settings: {} });
    expect(r.folded === false || r.stats?.folded === false).toBe(true);
    expect(r.body).toBe(body); // same reference — untouched
  });

  it("folds consumed history past the nudge threshold, preserving the recent zone", () => {
    const body = bigBody(30);
    const settings = { fold: { nudgeAt: 0.01, preserveRecentMessages: 6 } }; // force fold
    const r = processTurn({ body, provider: "openai", model: "gpt-5", settings });
    expect(r.stats.before).toBeGreaterThan(0);
    const out = r.body;
    expect(out).not.toBe(body);
    expect(Array.isArray(out.messages)).toBe(true);
    // Recent zone verbatim: the last message is untouched text.
    expect(out.messages[out.messages.length - 1].content).toContain("Reply 29");
    // Folded blocks appear as compression markers.
    const markers = out.messages.filter((m) => String(m.content).includes("[Compressed conversation section"));
    expect(markers.length).toBeGreaterThan(0);
  });

  it("fails open on garbage config", () => {
    const body = bigBody(2);
    const settings = { fold: { nudgeAt: "not-a-number", emergencyAt: null } };
    const r = processTurn({ body, provider: "x", model: "y", settings });
    expect(r.body.messages.length).toBeGreaterThan(0);
  });

  it("resolveFoldConfig clamps thresholds", () => {
    const cfg = resolveFoldConfig({ fold: { nudgeAt: 5, emergencyAt: 0.2 } });
    expect(cfg.nudgeAt).toBeLessThanOrEqual(0.95);
    expect(cfg.emergencyAt).toBeGreaterThanOrEqual(cfg.nudgeAt);
  });

  it("estimateTokens counts CJK and words", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("你好世界".repeat(10))).toBeGreaterThan(30);
    expect(estimateTokens("")).toBe(0);
  });

  it("fold tools execute server-side", () => {
    const body = bigBody(3);
    const c = executeFoldTool("compress_context", { summary: "the parser work happened" }, { body, settings: {} });
    expect(c.ok).toBe(true);
    const s = executeFoldTool("search_context", { query: "parser" }, { body, settings: {} });
    expect(s.ok).toBe(true);
    expect(s.hits.length).toBeGreaterThan(0);
    const d = executeFoldTool("decompress_context", {}, { body, settings: {} });
    expect(d.ok).toBe(true);
    const st = executeFoldTool("fold_status", {}, { body, settings: {} });
    expect(st.ok).toBe(true);
  });

  it("exposes 4 tool schemas", () => {
    expect(FOLD_TOOL_SCHEMAS).toHaveLength(4);
    for (const t of FOLD_TOOL_SCHEMAS) expect(t.function.name).toBeTruthy();
  });
});
