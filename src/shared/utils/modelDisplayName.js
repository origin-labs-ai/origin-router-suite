// Model ids carry a provider head, a vendor namespace and a deployment tag all at
// once: `openai-compatible-chat-53d16c96-c10e-4bbe/deepseek-v4.1-flash-uncensored`,
// `dahl/z-ai/glm-5.3-flash:batch`, `ollama-local/phonon:40m-multilingual`.
// A human wants the model: "DeepSeek-V4.1-Flash", "GLM-5.3-Flash", "Phonon-40M".
//
// Display only — the stored seat string and the request id never change.
//
// The owner's rules, taken from what actually broke in the picker:
//   • no provider head, no `@` routing code, no `/` in a label;
//   • the model's own name is kept whole, including the vendor word *inside* it:
//     `deepseek/deepseek-v4.1-flash` is "DeepSeek-V4.1-Flash", never "V4.1 Flash";
//   • `glm-5-3` and `glm-5.3` are the same model and read the same: "GLM-5.3";
//   • a publisher's own capitalisation survives (MiniMax, DeepSeek, TEE); an
//     all-lowercase id is humanized;
//   • tier and size words belong to the model (flash, pro, mini, 40m) and are never
//     cut; deployment noise (free, latest, batch, uncensored, build numbers) is.

const NUMERIC = /^\d+(?:[._]\d+)*$/;
const SIZE_TOKEN = /^[a-z]?\d+(?:\.\d+)?b$/i;
const HEX_TAIL = /^[0-9a-f]{6,}$/i;
const BUILD_NUMBER = /^\d{3,4}$/;

// Tokens that must be all upper-case in a label.
const ACRONYMS = new Set([
  "ai", "api", "glm", "gpt", "llm", "mcp", "ocr", "oss", "r1", "stt", "tts", "vl", "vlm",
]);

// Publisher-chosen casing worth preserving when the same model also appears in
// lower case somewhere in the catalog.
const CANONICAL_CASE = new Map([
  ["minimax", "MiniMax"], ["deepseek", "DeepSeek"], ["qwen", "Qwen"], ["kimi", "Kimi"],
  ["llama", "Llama"], ["mistral", "Mistral"], ["nemotron", "Nemotron"], ["longcat", "LongCat"],
  ["ernie", "ERNIE"], ["doubao", "Doubao"], ["hunyuan", "Hunyuan"], ["seed", "Seed"],
  ["grok", "Grok"], ["gemini", "Gemini"], ["claude", "Claude"], ["copilot", "Copilot"],
  ["codex", "Codex"], ["phi", "Phi"], ["gemma", "Gemma"], ["magistral", "Magistral"],
  ["sorcerer", "Sorcerer"], ["nanobanana", "NanoBanana"], ["glm", "GLM"], ["vlw", "VLW"],
  ["livetranslate", "LiveTranslate"], ["realtime", "Realtime"], ["flux", "FLUX"],
  ["v1m", "V1M"], ["ideogram", "Ideogram"], ["arxiv", "ArXiv"], ["mimo", "MiMo"],
  ["deepgram", "Deepgram"], ["novastt", "NovaSTT"],
]);

// Org / vendor namespace segments: routing metadata, never part of the label.
const ORG_SEGMENTS = new Set([
  "@cf", "@openrouter", "@ai", "accounts", "fireworks", "routers", "models", "publishers",
  "zai-org", "z-ai", "z.ai", "zai", "zhipu", "anthropic", "openai", "google", "deepmind",
  "meta", "meta-llama", "mistralai", "xai", "x-ai", "moonshot", "moonshotai", "cohere",
  "amazon", "aws", "bedrock", "microsoft", "azure", "nvidia", "perplexity", "bytedance",
  "baidu", "tencent", "stepfun", "nous", "nousresearch", "deepseek-ai", "qwen", "minimax",
  "mini-max", "zhipuai", "bigmodel", "xhs",
]);

// Deployment tags that describe how a model is served, not which model it is.
const NOISE_COLON_TAGS = new Set([
  "free", "latest", "preview", "beta", "experimental", "stable", "batch", "nitro", "eval",
  "thinking", "extended", "online", "standard",
]);

// Trailing words with the same meaning, written with a dash instead of a colon.
// `tee` is deliberately absent from the *colon* list below and present here: a TEE
// variant is the same model running in a trusted-execution deployment.
const NOISE_SUFFIX_TOKENS = new Set([
  "free", "latest", "preview", "beta", "experimental", "exp", "stable", "batch",
  "uncensored", "distill", "distilled", "awq", "gptq", "int4", "int8", "fp8", "fp16",
  "bf16", "bnb", "nocache", "online", "offline", "workflows", "standard", "tee", "uc", "nc",
]);

// Everything that qualifies *how* a model is run rather than *which* model it is.
// The owner's rule: whatever prefix or suffix a provider bolts on, the category is
// the model — `glm-5.3-flash-tee`, `glm-5.3-flash:batch` and `GLM-5.3-Flash` are one
// model; `deepseek-v4-pro-think-search` is `DeepSeek-V4-Pro`.
// Words that name a real product line (instruct, chat, code, think as a model name,
// audio/vision as a family) are deliberately NOT here — over-folding would hide models.
const FOLD_TOKENS = new Set([
  ...NOISE_SUFFIX_TOKENS,
  // effort / reasoning modes
  "thinking", "think", "high", "medium", "low", "minimal", "xhigh", "none",
  // agent roles and endpoints bolted onto the same model
  "agentic", "agent", "review", "search", "web",
  // modality tags a provider adds to a chat model's id
  "vision", "image", "images", "audio", "video", "pdf", "ocr",
  // quantization / build shapes
  "quant", "q4", "q8", "k_m", "km",
]);

// Words that DO identify a distinct model. These are never folded away, no matter
// where they sit: `flash` and `pro` are different products, not different deployments.
const TIER_TOKENS = new Set([
  "pro", "flash", "max", "ultra", "lite", "mini", "nano", "small", "tiny", "turbo",
  "air", "plus", "sol", "luna", "fable", "opus", "sonnet", "haiku", "k3", "express",
]);

function isFoldable(token) {
  const lower = String(token || "").toLowerCase();
  if (!lower || TIER_TOKENS.has(lower)) return false;
  // A 3+ digit tail (`1017`, `0731`) is a build stamp and a full date is a release
  // stamp: both fold, even though they are digits.
  if (BUILD_NUMBER.test(lower) || /^(19|20)\d{2}([-/]\d{1,2}){1,2}$/.test(lower)) return true;
  // A number that is part of the version never folds: `glm-5-3` is GLM-5.3, not GLM-5.
  if (NUMERIC.test(lower)) return false;
  return FOLD_TOKENS.has(lower);
}

// A final segment that says nothing on its own: `llama/main`, `qwen/chat`.
// Those keep their parent segment so the label still names a model.
const GENERIC_TAIL_SEGMENTS = new Set(["main", "chat", "latest", "default", "model", "stable", "version"]);

// An API-style id puts the version in its own segment: `fal-ai/flux-pro/v1.1`,
// `fal-ai/ideogram/v2`, `uc/1.0`. That segment alone is not a model name, so the
// segment before it is pulled in and the label reads "Flux Pro V1.1".
const VERSION_ONLY_SEGMENT = /^v?\d+(?:[._]\d+)*(?:-[a-z0-9]+)?$/i;

function isThinSegment(segment) {
  const lower = String(segment || "").toLowerCase();
  return GENERIC_TAIL_SEGMENTS.has(lower) || VERSION_ONLY_SEGMENT.test(lower);
}

/** Routing/org noise removed from a human-facing model label. */
export function cleanModelLabel(raw = "") {
  // `@cf/…` codes and vendor namespaces (`zai-org`, `MiniMaxAI`, `moonshotai`) are
  // routing metadata. What is left is provider head(s) plus the model's own last
  // segment, and only that last segment is the model: `cl/deepseek/deepseek-chat`
  // is "DeepSeek Chat", never "DeepSeek DeepSeek Chat", and
  // `openai-compatible-chat-53d16c96-…/MiniMaxAI/MiniMax-M3` is "MiniMax M3".
  const parts = String(raw || "")
    .split("/")
    .filter((segment) => segment && !segment.startsWith("@") && !ORG_SEGMENTS.has(segment.toLowerCase()));

  let value = "";
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    // A thin tail ("default", "v1.1") carries no model identity on its own, so the
    // segment before it is included.
    value = parts.length > 1 && isThinSegment(last) ? parts.slice(-2).join("-") : last;
  }
  if (!value) value = String(raw || "");
  // `~` marks "any provider" in some ids.
  value = value.replace(/~/g, "");
  // A known deployment tag after a colon goes; a real variant tag
  // (`:40m-multilingual`) stays, because it identifies a different model.
  value = value.replace(/:([a-z0-9._-]+)$/i, (match, tag) =>
    NOISE_COLON_TAGS.has(tag.toLowerCase()) ? "" : ` ${tag}`);
  return value.trim();
}

/** A model that still contains an `@` routing code is not offered in pickers. */
export function isHiddenModelName(raw = "") {
  return String(raw || "").split("/").some((segment) => segment.startsWith("@"));
}

/** The model's own tokens, noise dropped, publisher casing preserved. */
function nameTokens(raw = "") {
  const cleaned = cleanModelLabel(raw)
    // Live catalogs sometimes encode a version dot as `p` (`glm-5p3`).
    .replace(/(\d)p(\d)/gi, "$1.$2");
  // Parentheses and brackets are just more separators: "DeepSeek V4.1 Flash (Free)"
  // and "z-image-turbo-(uc)" fold the same way their dash-written twins do.
  let tokens = cleaned.split(/[-_/\s:()[\]]+/).filter(Boolean).flatMap((token) => {
    // Providers sometimes weld a build stamp onto a qualifier with no separator
    // (`deepseek-v4-flash-0731free`). Split it so the stamp can fold away.
    const welded = /^(\d{3,})([a-z]+)$/i.exec(token);
    return welded ? [welded[1], welded[2]] : [token];
  });

  // A snapshot date (`…-2026-04-16`) arrives split into three numeric pieces, so glue
  // it back into one token FIRST: only then is it recognisable as a release stamp and
  // folded, and only then can a version like `5-3` never be mistaken for one.
  const glued = [];
  const isYear = (token) => /^(19|20)\d{2}$/.test(token || "");
  const isMonthDay = (token) => /^\d{1,2}$/.test(token || "");
  for (let i = 0; i < tokens.length; i++) {
    if (isYear(tokens[i]) && isMonthDay(tokens[i + 1]) && isMonthDay(tokens[i + 2])) {
      glued.push(`${tokens[i]}-${tokens[i + 1]}-${tokens[i + 2]}`);
      i += 2;
      continue;
    }
    glued.push(tokens[i]);
  }
  tokens = glued;

  // Fold the tail: drop qualifiers until a tier word or a name word is reached.
  // At least two tokens survive so a model never collapses to nothing.
  while (tokens.length > 2 && isFoldable(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  // A leading duplicate of the vendor inside the model name is kept (`deepseek-chat`
  // under provider `deepseek` is still "DeepSeek Chat"), but a trailing hex fragment
  // left by a connection-scoped id is not a model word.
  if (tokens.length > 2 && HEX_TAIL.test(tokens[tokens.length - 1]) && !/\d$/.test(tokens[tokens.length - 2])) {
    tokens = tokens.slice(0, -1);
  }
  return tokens;
}

function humanizeToken(token) {
  const lower = token.toLowerCase();
  if (SIZE_TOKEN.test(token)) return `${token.slice(0, -1).toUpperCase()}B`;
  // A lone size tag (`40m`, `740m`) is a model variant, not a word to title-case.
  if (/^\d+(\.\d+)?m$/i.test(token)) return token.toUpperCase().replace(/\./g, ".");
  if (ACRONYMS.has(lower)) return token.toUpperCase();
  if (CANONICAL_CASE.has(lower)) return CANONICAL_CASE.get(lower);
  // A publisher that already capitalised the id keeps its casing (MiniMax, TEE).
  if (/[A-Z]/.test(token)) return token;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Human-friendly model name derived from an id.
 *
 * @param {string} raw e.g. "cl/z-ai/glm-5.3-flash:free"
 * @returns {string} e.g. "GLM-5.3-Flash"
 */
export function prettyModelName(raw = "") {
  const tokens = nameTokens(raw);
  const out = [];

  for (const token of tokens) {
    if (NUMERIC.test(token)) {
      const version = token.replace(/[._]/g, ".");
      const lastIndex = out.length - 1;
      if (lastIndex >= 0 && NUMERIC.test(out[lastIndex])) {
        // `5` followed by `1` is one version, not two words.
        out[lastIndex] = `${out[lastIndex]}.${version}`;
      } else if (lastIndex >= 0 && /\d$/.test(out[lastIndex])) {
        // `GLM-5` then `3` is still the same version: "GLM-5.3".
        out[lastIndex] = `${out[lastIndex]}.${version}`;
      } else if (lastIndex >= 0 && /^[A-Za-z]/.test(out[lastIndex]) && !out[lastIndex].includes("-")) {
        // A version attached to the stem reads `GLM-5.3`, not `GLM 5.3`.
        out[lastIndex] = `${out[lastIndex]}-${version}`;
      } else {
        out.push(version);
      }
      continue;
    }
    out.push(humanizeToken(token));
  }

  return out.join(" ").trim() || String(raw);
}

/**
 * Grouping key for one model: case and deployment noise removed, versions unified,
 * so `glm-5-3`, `glm-5.3` and `GLM-5.3:free` become one category while
 * `glm-5.3-flash` stays a different model.
 */
export function modelIdentity(raw = "") {
  return nameTokens(raw)
    .map((token) => (NUMERIC.test(token) ? token.replace(/[._]/g, ".") : token.toLowerCase()))
    .join("-")
    .replace(/(\d)-(\d)/g, "$1.$2");
}

/** Case-insensitive form of the identity — the key groups are actually merged on. */
export function modelGroupKey(raw = "") {
  return modelIdentity(raw).toLowerCase();
}

/**
 * Category label for a single id: the model's name with the deployment noise off.
 * Grouping members is `modelGroupKey`; this is what a row is titled.
 */
export function modelCategoryName(raw = "") {
  return prettyModelName(raw);
}

/**
 * Label for a group of spellings. The catalog holds `minimax-m3` and `MiniMax-M3`
 * as the same model under different providers; the readable one wins, so the group
 * never loses a publisher's capitalisation just because a lowercase copy came first.
 */
export function groupDisplayName(ids = [], fallback = "") {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (list.length === 0) return prettyModelName(fallback);
  const cased = list.find((id) => /[A-Z]/.test(cleanModelLabel(id)));
  return prettyModelName(cased || list[0]);
}

/**
 * Search key: letters and digits only, lowercased. `minimax m3.1 flash`,
 * `minimax-m3.1-flash-free` and `minimaxm31flash` all land on the same model. This
 * exists because prefixes, suffixes, colons and connection names made a plain
 * substring search miss the very model the owner was looking for.
 */
export function modelSearchKey(raw = "") {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Does a free-text query match this model, ignoring punctuation and spelling form? */
export function modelMatchesQuery(raw, query) {
  const words = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    modelSearchKey(raw),
    modelSearchKey(cleanModelLabel(raw)),
    modelSearchKey(modelIdentity(raw)),
    modelSearchKey(prettyModelName(raw)),
  ];
  // Every word must appear somewhere, and one word must appear in the model's own
  // name so a provider alias alone never matches an unrelated model.
  const nameKeys = haystack.slice(1);
  return words.every((word) => haystack.some((key) => key.includes(word)))
    && words.some((word) => nameKeys.some((key) => key.includes(word)));
}

/**
 * What the playground should show for a combo: the name the user typed, or a
 * pretty derivation of the combo id.
 */
export function comboDisplayLabel(combo) {
  const custom = typeof combo?.displayName === "string" ? combo.displayName.trim() : "";
  if (custom) return custom;
  return prettyModelName(combo?.name || "");
}
