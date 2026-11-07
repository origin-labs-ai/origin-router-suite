// v060-port.js — the v0.6.000 provider expansion, one table, one file.
//
// 44 new OpenAI-compatible API-key providers curated from the two reference
// catalogs (OmniRoute v3.8.54 + Free Claude Code), minus the dead list:
// shut-down, expired, web-cookie-only and special-auth endpoints are excluded
// on purpose (notes inline in the table). Every entry is a plain bearer-key
// OpenAI-compatible endpoint the default executor serves as-is.
//
// Letter glyphs + accent colors follow src/shared/utils/providerGlyph.js
// (NexAPI → "N", OrcaRouter → "OR"; deterministic palette hash per id).
//
// Loader note: this module exports an ARRAY of entries; the loader flattens
// arrays, so registry/index.js needs only one import line for all 44.

const PALETTE = [
  "#2B7FFF", "#10A37F", "#8B5CF6", "#F59E0B", "#EC4899", "#14B8A6", "#F97316", "#6366F1",
  "#22C55E", "#E11D48", "#0EA5E9", "#A855F7", "#D946EF", "#84CC16", "#EF4444", "#06B6D4",
];

function accentColor(id) {
  let h = 2166136261;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function glyph(name) {
  const segments = String(name || "")
    .replace(/([a-z])([A-Z])/g, "$1\u0000$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\u0000$2")
    .split(/[\u0000\-\_\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return "?";
  const acronymTail = segments.slice(1).some((seg) => seg.length >= 2 && seg === seg.toUpperCase() && /^[A-Z]+$/.test(seg));
  if (acronymTail || segments.length === 1) return segments[0].charAt(0).toUpperCase();
  return (segments[0].charAt(0) + segments[1].charAt(0)).toUpperCase();
}

const TABLE = [
  // ── From Free Claude Code's catalog ──
  ["deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai", "https://deepinfra.com", "https://deepinfra.com/dash/keys", "apikey", "OpenAI-compatible inference host for OSS models."],
  ["wandb", "W&B Inference", "https://api.inference.wandb.ai/v1", "https://wandb.ai", "https://wandb.ai/authorize", "apikey", ""],
  ["atlascloud", "Atlas Cloud", "https://api.atlascloud.ai/v1", "https://atlascloud.ai", "https://cloud.atlascloud.ai", "apikey", ""],
  ["xkiro", "xKiro", "https://api.xkiro.com/v1", "https://xkiro.com", "", "apikey", ""],
  ["opper", "Opper", "https://api.opper.ai/v3/compat", "https://www.opper.ai", "", "apikey", "OpenAI-compatible layer at /v3/compat."],
  ["nararoute", "NaraRoute", "https://router.bynara.id/v1", "https://bynara.id", "", "apikey", ""],
  ["experiential", "Experiential Labs", "https://api.experientiallabs.ai/v1", "https://experientiallabs.ai", "", "apikey", ""],
  ["cheaperinference", "Cheaper Inference", "https://api.cheaperinference.com/v1", "https://cheaperinference.com", "", "apikey", ""],
  ["orcarouter", "OrcaRouter", "https://api.orcarouter.ai/v1", "https://orcarouter.ai", "", "apikey", ""],
  ["lightning", "Lightning AI", "https://lightning.ai/api/v1", "https://lightning.ai", "", "apikey", ""],
  ["zenmux", "ZenMux", "https://zenmux.ai/api/v1", "https://zenmux.ai", "", "apikey", ""],
  ["zai", "Z.ai", "https://api.z.ai/api/coding/paas/v4", "https://z.ai", "https://z.ai/manage-api-key/apikey-list", "apikey", "Coding-plan endpoint; the pay-as-you-go base is https://api.z.ai/api/paas/v4."],
  ["kimi-code", "Kimi Code", "https://api.kimi.com/coding/v1", "https://www.kimi.com", "", "apikey", ""],
  ["codestral", "Codestral", "https://codestral.mistral.ai/v1", "https://codestral.mistral.ai", "https://admin.mistral.ai/plateforme/keys", "apikey", ""],
  ["alibaba-cloud", "Alibaba Cloud ModelStudio", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://www.alibabacloud.com/en/product/modelstudio", "", "apikey", "International DashScope compatible-mode endpoint."],
  ["qwencloud", "QwenCloud Token Plan", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "https://www.alibabacloud.com/en/product/modelstudio", "", "apikey", ""],
  ["qwencloud-coding", "QwenCloud Coding Plan", "https://coding-intl.dashscope.aliyuncs.com/v1", "https://www.alibabacloud.com/en/product/modelstudio", "", "apikey", ""],
  ["ollama-cloud", "Ollama Cloud", "https://ollama.com/v1", "https://ollama.com", "https://ollama.com/settings/keys", "apikey", "Hosted Ollama; the local daemon is a separate provider."],
  // ── From OmniRoute's catalog ──
  ["aimlapi", "AI/ML API", "https://api.aimlapi.com/v1", "https://aimlapi.com", "https://aimlapi.com/app/keys", "apikey", ""],
  ["novita", "Novita AI", "https://api.novita.ai/openai/v1", "https://novita.ai", "https://novita.ai/dashboard/llm-api-key", "apikey", ""],
  ["electronhub", "ElectronHub", "https://api.electronhub.top/v1", "https://electronhub.top", "", "apikey", ""],
  ["llmgateway", "LLM Gateway", "https://api.llmgateway.io/v1", "https://llmgateway.io", "https://llmgateway.io/dashboard/keys", "apikey", ""],
  ["nanogpt", "NanoGPT", "https://nano-gpt.com/api/v1", "https://nano-gpt.com", "https://nano-gpt.com/api", "apikey", ""],
  ["requesty", "Requesty", "https://router.requesty.ai/v1", "https://requesty.ai", "https://app.requesty.ai/keys", "apikey", "Multi-provider router: hundreds of models via one key."],
  ["friendliai", "FriendliAI", "https://api.friendli.ai/serverless/v1", "https://friendli.ai", "https://friendli.ai/suite/personal-tasks", "apikey", "Serverless inference for OSS models."],
  ["inference-net", "Inference.net", "https://api.inference.net/v1", "https://inference.net", "", "apikey", ""],
  ["lambda-ai", "Lambda", "https://api.lambda.ai/v1", "https://lambda.ai", "https://cloud.lambda.ai", "apikey", ""],
  ["digitalocean", "DigitalOcean GenAI", "https://inference.do-ai.run/v1", "https://www.digitalocean.com/products/gen-ai-platform", "", "apikey", ""],
  ["nscale", "Nscale", "https://api.nscale.com/v1", "https://nscale.com", "", "apikey", ""],
  ["monsterapi", "Monster API", "https://api.monsterapi.ai/v1", "https://monsterapi.ai", "", "apikey", ""],
  ["ovhcloud", "OVHcloud AI Endpoints", "https://oai.endpoints.ke.ai.ovh.net/v1", "https://endpoints.ke.ai.ovh.net", "", "apikey", "OVHcloud AI Endpoints, OpenAI-compatible."],
  ["ai21", "AI21 Labs", "https://api.ai21.com/studio/v1", "https://www.ai21.com", "", "apikey", ""],
  ["writer", "Writer", "https://api.writer.com/v1", "https://writer.com", "", "apikey", ""],
  ["segmind", "Segmind", "https://api.segmind.com/v1", "https://www.segmind.com", "", "apikey", ""],
  ["upstage", "Upstage Solar", "https://api.upstage.ai/v1/solar", "https://www.upstage.ai", "", "apikey", ""],
  ["sarvam", "Sarvam AI", "https://api.sarvam.ai/v1", "https://www.sarvam.ai", "", "apikey", ""],
  ["typhoon", "Typhoon", "https://api.opentyphoon.ai/v1", "https://opentyphoon.ai", "", "apikey", "Thai LLM family by SCB 10X."],
  ["sealion", "SEA Lion", "https://api.sea-lion.ai/v1", "https://sea-lion.ai", "", "apikey", "SEA LION open models by AI Singapore."],
  ["qianfan", "Qianfan", "https://qianfan.baidubce.com/v2", "https://qianfan.baidubce.com", "", "apikey", "Baidu Qianfan platform, OpenAI-compatible v2 surface."],
  ["sparkdesk", "iFlyTek Spark", "https://spark-api-open.xf-yun.com/v1", "https://www.xfyun.cn", "", "apikey", "iFlyTek Spark open platform, OpenAI-compatible."],
  ["modelscope", "ModelScope API-Inference", "https://api-inference.modelscope.cn/v1", "https://modelscope.cn", "https://modelscope.cn/my/myaccesstoken", "apikey", "Alibaba model hub; free tier for many OSS models."],
  // ── From the owner's OpenCode CLI catalog (alive endpoints, key-less imports) ──
  ["naga", "NagaAI", "https://api.naga.ac/v1", "https://naga.ac", "", "apikey", ""],
  ["modal", "Modal Research", "https://api.us-west-2.modal.direct/v1", "https://modal.com", "", "apikey", "Research endpoint; the wire base carries a /chat/completions suffix."],
  ["interfaceai", "InterfaceAI", "https://api.jiekou.ai/openai/v1", "https://jiekou.ai", "", "apikey", "OpenAI-compatible surface under /openai/v1."],
  ["aerolink", "Aerolink", "https://capi.aerolink.lat", "https://aerolink.lat", "", "apikey", ""],
  ["g0i", "G0I", "https://api.g0i.ai/v1", "https://g0i.ai", "", "apikey", ""],
  ["kie", "Kie", "https://api.kie.ai/claude/v1", "https://kie.ai", "", "apikey", "Claude-compatible surface at /claude/v1."],
];

export default TABLE.map(([id, name, base, website, keyUrl, category, note]) => ({
  id,
  priority: 120,
  alias: id,
  uiAlias: id,
  display: {
    name,
    icon: "hub",
    color: accentColor(id),
    textIcon: glyph(name),
    ...(website ? { website } : {}),
    ...(keyUrl || note ? { notice: { ...(note ? { text: note } : {}), ...(keyUrl ? { apiKeyUrl: keyUrl } : {}) } } : {}),
  },
  category,
  authType: "apikey",
  transport: {
    baseUrl: `${base}/chat/completions`,
    validateUrl: `${base}/models`,
  },
  models: [],
  passthroughModels: true,
}));
