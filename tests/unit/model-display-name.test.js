import { describe, expect, it } from "vitest";
import {
  cleanModelLabel,
  comboDisplayLabel,
  groupDisplayName,
  isHiddenModelName,
  modelCategoryName,
  modelGroupKey,
  modelIdentity,
  modelMatchesQuery,
  prettyModelName,
} from "../../src/shared/utils/modelDisplayName.js";

// The owner's rule, in his words: a label shows the model, not the routing.
// No `@`, no `/`, no provider head, no deployment noise — and the same model
// spelled three ways must read as one model.
describe("model display names", () => {
  it("reduces an id to the model itself", () => {
    expect(prettyModelName("cl/z-ai/glm-5.3-flash:batch")).toBe("GLM-5.3 Flash");
    expect(prettyModelName("glm/glm-5.3")).toBe("GLM-5.3");
    expect(prettyModelName("glm-5-3")).toBe("GLM-5.3");
    expect(prettyModelName("deepseek/deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
    expect(prettyModelName("cl/deepseek/deepseek-chat")).toBe("DeepSeek Chat");
  });

  it("drops provider heads of every shape: alias, connection id, vendor namespace", () => {
    const ids = [
      "openai-compatible-chat-0a2a5b27-c875-48c7-a79d-31cc6cbd50fa/MiniMaxAI/MiniMax-M3.1-Flash",
      "openai-compatible-chat-ec929aa3-7f3e-4d8f-b00e-5040332a911f/free/minimax-m3.1-flash",
      "oc/minimax-m3.1-flash-free",
      "cl/cline-free/minimax-m3.1-flash",
      "mmg/MiniMax-M3.1-Flash",
    ];
    for (const id of ids) {
      const label = prettyModelName(id);
      expect(label).toBe("MiniMax M3.1 Flash");
      expect(label).not.toContain("/");
      expect(label).not.toContain("@");
    }
  });

  it("never leaks a provider or connection word into a label", () => {
    const samples = [
      "ollama-local/snowflake-arctic-embed:335m",
      "openai-compatible-chat-53d16c96-c10e-4bbe-a2cb-4747867a059e/DeepSeek-V4.1-Flash",
      "cloudflare-ai/@cf/moonshotai/kimi-k2.5",
    ];
    for (const id of samples) {
      const label = prettyModelName(id).toLowerCase();
      expect(label).not.toMatch(/ollama|compatible|chat-|cloudflare|moonshotai|cognitive/);
    }
  });

  it("keeps tier and size words, because they identify a different model", () => {
    expect(prettyModelName("glm/glm-5.3")).not.toBe(prettyModelName("glm/glm-5.3-flash"));
    expect(prettyModelName("ollama-local/phonon:40m-multilingual")).toContain("40M");
    expect(prettyModelName("cl/openai/gpt-6.1-sol-pro")).toBe("GPT-6.1 Sol Pro");
  });

  // Deployment noise folds; publisher casing survives on the words that stay.
  // These two assertions used to demand the opposite for TEE and snapshot dates,
  // which contradicts the rule the naming work was built on (and the runnable
  // contract in tests/tmp-name-rules.mjs): a TEE variant is the same model in a
  // trusted-execution deployment, and a date is a release stamp, not a model.
  it("preserves a publisher's own casing on the words that identify the model", () => {
    expect(prettyModelName("mm/MiniMax-M3")).toBe("MiniMax M3");
    expect(prettyModelName("cbcn/minimax-m3")).toBe("MiniMax M3");
    expect(prettyModelName("mm/MiniMax-M3.1-Flash")).toBe("MiniMax M3.1 Flash");
  });

  it("folds TEE and UC deployment tags into the model they describe", () => {
    expect(prettyModelName("some-provider/deepseek-v3-TEE")).toBe("DeepSeek V3");
    expect(prettyModelName("some-provider/deepseek-v3")).toBe(prettyModelName("some-provider/deepseek-v3-TEE"));
    expect(prettyModelName("glm/glm-5.3-flash-tee")).toBe(prettyModelName("glm/glm-5.3-flash"));
  });

  it("folds snapshot dates and build stamps into the model they version", () => {
    expect(prettyModelName("x/qwen3.6-flash-2026-04-16")).toBe("Qwen3.6 Flash");
    expect(prettyModelName("rc/deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("DeepSeek V4.1 Flash");
    expect(prettyModelName("x/qwen3.6-flash")).toBe(prettyModelName("x/qwen3.6-flash-2026-04-16"));
  });

  it("groups the spellings of one model under a single key", () => {
    const spellings = ["glm/glm-5-3", "glm/glm-5.3", "cbcn/GLM-5.3:free", "oc/glm-5.3-free"];
    const keys = new Set(spellings.map(modelGroupKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("glm-5.3");
    // …and a different model does not join them
    expect(modelGroupKey("glm/glm-5.3-flash")).not.toBe("glm-5.3");
  });

  it("labels a group with its best-cased spelling", () => {
    expect(groupDisplayName(["minimax/minimax-m3", "mm/MiniMax-M3"])).toBe("MiniMax M3");
  });

  it("finds a model whatever the query's punctuation is", () => {
    const id = "openai-compatible-chat-0a2a5b27-c875-48c7-a79d-31cc6cbd50fa/MiniMaxAI/MiniMax-M3.1-Flash";
    for (const query of ["minimax m3.1 flash", "minimaxm31flash", "M3.1-Flash", "flash minimax"]) {
      expect(modelMatchesQuery(id, query)).toBe(true);
    }
    expect(modelMatchesQuery(id, "glm")).toBe(false);
  });

  it("exposes the raw parts for callers that need them, and hides @-routed models", () => {
    expect(cleanModelLabel("openai/gpt-5.6-sol-pro:free")).toBe("gpt-5.6-sol-pro");
    expect(modelIdentity("openai/gpt-5.6-sol-pro:free")).toBe("gpt-5.6-sol-pro");
    expect(modelCategoryName("kr/glm-5.3-flash-free")).toBe("GLM-5.3 Flash");
    expect(isHiddenModelName("cf/@xai/grok-4")).toBe(true);
    expect(isHiddenModelName("cf/grok-4")).toBe(false);
    expect(comboDisplayLabel({ name: "claude-opus-5-5", displayName: "Opus 5.5" })).toBe("Opus 5.5");
    expect(comboDisplayLabel({ name: "claude-opus-5-5" })).toBe("Claude Opus-5.5");
  });
});
