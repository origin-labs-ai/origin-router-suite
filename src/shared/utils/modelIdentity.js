import { AI_PROVIDERS } from "@/shared/constants/providers";
import { modelCategoryName, modelGroupKey, prettyModelName } from "@/shared/utils/modelDisplayName";

// A routed model id can carry up to three layers:
//
//   ag/Anthropic/claude-sonnet-5-5-high
//   ^^ ^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^
//   |  |          model id sent upstream
//   |  model vendor (the model was made by Anthropic)
//   local provider (the account is connected through Antigravity)
//
// The provider layer is the connection; the vendor layer is not. Keeping them
// separate is what lets the playground list this once as an Anthropic model,
// offered by Antigravity, instead of as a provider called "Anthropic" or a raw
// string. Bare ids inherit the provider from the connection they came from.

const VENDORS = new Map([
  ["anthropic", "Anthropic"],
  ["claude", "Anthropic"],
  ["openai", "OpenAI"],
  ["google", "Google"],
  ["gemini", "Google"],
  ["deepmind", "Google"],
  ["meta", "Meta"],
  ["meta-llama", "Meta"],
  ["llama", "Meta"],
  ["mistral", "Mistral"],
  ["mistralai", "Mistral"],
  ["xai", "xAI"],
  ["x-ai", "xAI"],
  ["grok", "xAI"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["alibaba", "Qwen"],
  ["moonshot", "Moonshot"],
  ["moonshotai", "Moonshot"],
  ["kimi", "Moonshot"],
  ["zhipu", "Zhipu"],
  ["z-ai", "Zhipu"],
  ["z.ai", "Zhipu"],
  ["zai", "Zhipu"],
  ["zai-org", "Zhipu"],
  ["glm", "Zhipu"],
  ["cohere", "Cohere"],
  ["amazon", "Amazon"],
  ["aws", "Amazon"],
  ["bedrock", "Amazon"],
  ["microsoft", "Microsoft"],
  ["azure", "Microsoft"],
  ["nvidia", "NVIDIA"],
  ["perplexity", "Perplexity"],
  ["minimax", "MiniMax"],
  ["bytedance", "ByteDance"],
  ["baidu", "Baidu"],
  ["tencent", "Tencent"],
  ["stepfun", "StepFun"],
  ["nous", "Nous"],
  ["nousresearch", "Nous"],
  ["ai21", "AI21"],
  ["databricks", "Databricks"],
  ["ibm", "IBM"],
  ["sambanova", "SambaNova"],
  ["together", "Together"],
  ["fireworks", "Fireworks"],
  ["cerebras", "Cerebras"],
  ["groq", "Groq"],
]);

const VENDOR_PREFIXES = [
  ["claude", "Anthropic"],
  ["anthropic", "Anthropic"],
  ["gpt-", "OpenAI"],
  ["o1", "OpenAI"],
  ["o3", "OpenAI"],
  ["o4", "OpenAI"],
  ["text-embedding", "OpenAI"],
  ["dall-e", "OpenAI"],
  ["whisper", "OpenAI"],
  ["gemini", "Google"],
  ["gemma", "Google"],
  ["imagen", "Google"],
  ["veo", "Google"],
  ["learnlm", "Google"],
  ["llama", "Meta"],
  ["mistral", "Mistral"],
  ["mixtral", "Mistral"],
  ["codestral", "Mistral"],
  ["magistral", "Mistral"],
  ["grok", "xAI"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["qwq", "Qwen"],
  ["kimi", "Moonshot"],
  ["moonshot", "Moonshot"],
  ["glm", "Zhipu"],
  ["command", "Cohere"],
  ["nova-", "Amazon"],
  ["titan", "Amazon"],
  ["phi-", "Microsoft"],
  ["nemotron", "NVIDIA"],
  ["sonar", "Perplexity"],
  ["minimax", "MiniMax"],
  ["doubao", "ByteDance"],
  ["seed-", "ByteDance"],
  ["ernie", "Baidu"],
  ["hunyuan", "Tencent"],
  ["step-", "StepFun"],
  ["hermes", "Nous"],
  ["jamba", "AI21"],
];

// provider id + UI alias -> canonical provider id. The alias is what routed
// ids use (`ag/...`), the id is what connections and capability tables use.
const PROVIDER_SEGMENTS = new Map();
for (const provider of Object.values(AI_PROVIDERS || {})) {
  if (provider?.id) PROVIDER_SEGMENTS.set(provider.id.toLowerCase(), provider.id);
  if (provider?.alias) PROVIDER_SEGMENTS.set(provider.alias.toLowerCase(), provider.id);
}

function providerLabel(providerId) {
  const provider = providerId ? AI_PROVIDERS?.[providerId] : null;
  return provider?.name || providerId || "";
}

function inferVendor(model) {
  // Aggregators prefix routed ids with `~` (`~anthropic/claude-...`).
  const value = String(model || "").toLowerCase().replace(/^~+/, "");
  for (const [prefix, vendor] of VENDOR_PREFIXES) {
    if (value === prefix || value.startsWith(prefix)) return vendor;
  }
  return "";
}

/**
 * Group two ids that mean the same model. Version punctuation and case are
 * normalized (`claude-sonnet-4.6` == `claude-sonnet-4-6`) and deployment qualifiers
 * (free, latest, thinking, an effort level, a build number, TEE) collapse away —
 * whatever prefix or suffix a provider bolts on, the category is the model.
 *
 * The rules live in modelDisplayName.js so the picker, the combo editor, the tier
 * classifier and the router all group a seat the same way.
 */
export function canonicalModelId(model) {
  return modelGroupKey(String(model || ""));
}

/**
 * @param {string} rawValue routed id, e.g. `ag/Anthropic/claude-sonnet-5-5`
 * @param {string} [fallbackProviderId] connection provider when no prefix exists
 * @param {string} [fallbackProviderName]
 */
export function parseModelIdentity(rawValue, fallbackProviderId = "", fallbackProviderName = "") {
  const raw = String(rawValue || "").trim();
  const segments = raw.split("/").filter(Boolean);

  let providerId = fallbackProviderId;
  let providerWasExplicit = false;
  if (segments.length > 1) {
    const mapped = PROVIDER_SEGMENTS.get(segments[0].toLowerCase());
    if (mapped) {
      providerId = mapped;
      providerWasExplicit = true;
      segments.shift();
    }
  }

  let vendor = "";
  if (segments.length > 1) {
    const mapped = VENDORS.get(segments[0].toLowerCase().replace(/^~+/, ""));
    if (mapped) {
      vendor = mapped;
      segments.shift();
    }
  }

  const model = segments.join("/") || raw;
  if (!vendor) vendor = inferVendor(model);

  const providerName = providerLabel(providerId) || fallbackProviderName || humanizeProvider(providerId);
  return {
    providerId: providerId || "",
    providerName,
    providerWasExplicit,
    vendor,
    model,
    displayName: prettyModelName(model) || raw,
    categoryName: modelCategoryName(model) || prettyModelName(model) || raw,
    // Categories are keyed by the exact model id, not by the routed vendor:
    // the same model served by Antigravity, OpenRouter and a direct account is
    // one category with several providers.
    groupKey: canonicalModelId(model) || raw.toLowerCase(),
  };
}

function humanizeProvider(value = "") {
  return String(value)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
