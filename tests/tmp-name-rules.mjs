// Same rules as tests/unit/model-display-name.test.js, runnable without vitest
// (which is not installed in this checkout): plain assert over the real catalog
// module, so the naming rules can be verified while iterating.
import assert from "node:assert/strict";
import { modelTier } from "../src/shared/utils/modelTier.js";
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
} from "./_nameHarness.js";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(`PASS  ${name}`);
  } catch (error) {
    checks.push(`FAIL  ${name}\n        ${error.message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

check("id reduces to the model", () => {
  assert.equal(prettyModelName("cl/z-ai/glm-5.3-flash:batch"), "GLM-5.3 Flash");
  assert.equal(prettyModelName("glm/glm-5.3"), "GLM-5.3");
  assert.equal(prettyModelName("glm-5-3"), "GLM-5.3");
  assert.equal(prettyModelName("deepseek/deepseek-v4.1-flash"), "DeepSeek V4.1 Flash");
  assert.equal(prettyModelName("cl/deepseek/deepseek-chat"), "DeepSeek Chat");
});

check("provider heads dropped in every shape", () => {
  const ids = [
    "openai-compatible-chat-0a2a5b27-c875-48c7-a79d-31cc6cbd50fa/MiniMaxAI/MiniMax-M3.1-Flash",
    "openai-compatible-chat-ec929aa3-7f3e-4d8f-b00e-5040332a911f/free/minimax-m3.1-flash",
    "oc/minimax-m3.1-flash-free",
    "cl/cline-free/minimax-m3.1-flash",
    "mmg/MiniMax-M3.1-Flash",
  ];
  for (const id of ids) assert.equal(prettyModelName(id), "MiniMax M3.1 Flash", `from ${id}`);
});

check("no provider or connection word leaks", () => {
  const samples = [
    "ollama-local/snowflake-arctic-embed:335m",
    "openai-compatible-chat-53d16c96-c10e-4bbe-a2cb-4747867a059e/DeepSeek-V4.1-Flash",
    "cloudflare-ai/@cf/moonshotai/kimi-k2.5",
  ];
  for (const id of samples) {
    const label = prettyModelName(id).toLowerCase();
    assert.doesNotMatch(label, /ollama|compatible|cloudflare|moonshotai/, `from ${id}: "${label}"`);
  }
});

check("tier and size words survive", () => {
  assert.notEqual(prettyModelName("glm/glm-5.3"), prettyModelName("glm/glm-5.3-flash"));
  assert.match(prettyModelName("ollama-local/phonon:40m-multilingual"), /40M/);
  assert.equal(prettyModelName("cl/openai/gpt-6.1-sol-pro"), "GPT-6.1 Sol Pro");
});

check("publisher casing preserved, qualifier tails folded away", () => {
  assert.equal(prettyModelName("mm/MiniMax-M3"), "MiniMax M3");
  // the owner's rule: a TEE suffix is still the same model
  assert.equal(modelGroupKey("some-provider/deepseek-v3-TEE"), "deepseek-v3");
  assert.equal(prettyModelName("some-provider/deepseek-v3-TEE"), "DeepSeek V3");
  assert.equal(prettyModelName("cbcn/minimax-m3"), "MiniMax M3");
});

check("release stamps fold into the model", () => {
  assert.equal(prettyModelName("x/qwen3.6-flash-2026-04-16"), "Qwen3.6 Flash");
  assert.equal(modelGroupKey("x/qwen3.6-flash-2026-04-16"), "qwen3.6-flash");
});

check("api-style ids keep their model segment", () => {
  assert.equal(prettyModelName("fal-ai/fal-ai/flux-pro/v1.1"), "FLUX Pro V1.1");
  assert.equal(prettyModelName("fal-ai/fal-ai/flux-pro/v1.1-ultra"), "FLUX Pro V1.1 Ultra");
  assert.equal(prettyModelName("fal-ai/fal-ai/ideogram/v2"), "Ideogram V2");
});

check("one model, one group key", () => {
  const keys = new Set(["glm/glm-5-3", "glm/glm-5.3", "cbcn/GLM-5.3:free", "oc/glm-5.3-free"].map(modelGroupKey));
  assert.equal(keys.size, 1, `got ${[...keys].join(", ")}`);
  assert.notEqual(modelGroupKey("glm/glm-5.3-flash"), "glm-5.3");
});

check("group label prefers the cased spelling", () => {
  assert.equal(groupDisplayName(["minimax/minimax-m3", "mm/MiniMax-M3"]), "MiniMax M3");
});

check("search ignores punctuation and spelling form", () => {
  const id = "openai-compatible-chat-0a2a5b27-c875-48c7-a79d-31cc6cbd50fa/MiniMaxAI/MiniMax-M3.1-Flash";
  for (const query of ["minimax m3.1 flash", "minimaxm31flash", "M3.1-Flash", "flash minimax"]) {
    assert.equal(modelMatchesQuery(id, query), true, `query "${query}"`);
  }
  assert.equal(modelMatchesQuery(id, "glm"), false);
});

check("the owner's examples fold to one model, whatever the prefix or suffix", () => {
  const spellings = [
    "glm/glm-5.3",
    "glm/glm-5-3",
    "cbcn/GLM-5.3:free",
    "oc/glm-5.3-tee",
    "openai-compatible-chat-769752da-585f-4b85-89a7-201215b9e6e8/glm-5.3-latest",
    "kr/glm-5.3 (free)",
  ];
  for (const seat of spellings) {
    assert.equal(modelGroupKey(seat), "glm-5.3", `${seat} → ${modelGroupKey(seat)}`);
  }
  // …but the flash variant is a different model and stays its own category
  assert.equal(modelGroupKey("glm/glm-5.3-flash-tee"), "glm-5.3-flash");
  // effort/agent suffixes fold: the model is still Opus 5.5
  assert.equal(modelGroupKey("cc/claude-opus-5.5-thinking-agentic"), "claude-opus-5.5");
  assert.equal(modelGroupKey("cl/deepseek/deepseek-v4-pro-think-search"), "deepseek-v4-pro");
  // a build number is not part of the model
  assert.equal(modelGroupKey("rc/deepseek-ai/DeepSeek-V4.1-Flash-1017"), "deepseek-v4.1-flash");
});

check("tiers: Pro and Flash, with DeepSeek-Flash inside Flash", () => {
  const pro = ["cc/claude-opus-5.5", "mm/gpt-6.1-sol-pro", "cl/deepseek/deepseek-v4-pro", "glm/glm-5.3", "qd/qmodel_38max"];
  for (const seat of pro) assert.equal(modelTier(seat).tier, "pro", `${seat} → ${modelTier(seat).tier}`);

  const flash = ["oc/qwen3.8-flash", "kimi/mimo-v2.6-flash-free", "mm/MiniMax-M3.1-Flash", "glm/glm-5.3-flash", "rc/deepseek-ai/DeepSeek-V4.1-Flash-1017"];
  for (const seat of flash) assert.equal(modelTier(seat).tier, "flash", `${seat} → ${modelTier(seat).tier}`);

  assert.equal(modelTier("rc/deepseek-ai/DeepSeek-V4.1-Flash-1017").subcategory, "Flash / DeepSeek-Flash");
  assert.equal(modelTier("glm/glm-5.3-flash").subcategory, "Flash / GLM-Flash");
  assert.equal(modelTier("cc/claude-opus-5.5").subcategory, "Pro / Claude");
});

check("a free deployment sits in the Flash pool, not Pro", () => {
  // `free` is folded out of the grouping key on purpose, so the tier has to read it
  // off the raw id: these are $0 seats and the brain must not spend hard work on them.
  assert.equal(modelTier("or/tencent/hy4-preview-free").tier, "flash");
  assert.equal(modelTier("or/tencent/hy4-preview-free").subcategory, "Flash / Hunyuan-Flash");
  assert.equal(modelTier("bzl/deepseek/deepseek-v4-flash-0731free").tier, "flash");
  assert.equal(modelTier("cl/z-ai/glm-5.3:free").subcategory, "Flash / GLM-Flash");
  // The paid twin of the same model stays Pro.
  assert.equal(modelTier("or/tencent/hy4-preview").tier, "pro");
  // A model whose own name starts with "free" is not a free deployment.
  assert.equal(modelTier("x/freewill-7b").tier, "pro");
});

check("an opaque provider id is labelled by the catalog name it ships with", () => {
  // qd/qfmodel is Qwen3.8-Flash; the name is the only honest way to say it.
  const seat = "qd/qfmodel";
  assert.equal(prettyModelName(seat), "Qfmodel");
  const named = modelTier(seat, "Qwen3.8-Flash");
  assert.equal(named.label, "Qwen3.8 Flash");
  assert.equal(named.tier, "flash");
  assert.equal(named.family, "Qwen");
  assert.equal(modelTier("qd/gmodel", "GLM-5.3").subcategory, "Pro / GLM");
  assert.equal(modelTier("qd/dfmodel", "DeepSeek-V4-Flash").subcategory, "Flash / DeepSeek-Flash");
});

check("helpers", () => {
  assert.equal(cleanModelLabel("openai/gpt-5.6-sol-pro:free"), "gpt-5.6-sol-pro");
  assert.equal(modelIdentity("openai/gpt-5.6-sol-pro:free"), "gpt-5.6-sol-pro");
  assert.equal(modelCategoryName("kr/glm-5.3-flash-free"), "GLM-5.3 Flash");
  assert.equal(isHiddenModelName("cf/@xai/grok-4"), true);
  assert.equal(isHiddenModelName("cf/grok-4"), false);
  assert.equal(comboDisplayLabel({ name: "claude-opus-5-5", displayName: "Opus 5.5" }), "Opus 5.5");
  assert.equal(comboDisplayLabel({ name: "claude-opus-5-5" }), "Claude Opus-5.5");
});

console.log(checks.join("\n"));
console.log(`\n${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
