// Model ids carry version digits in machine form: `claude-fable-5-1`,
// `glm-5.3-flash`. Humans read those as "Claude Fable 5.1" and "GLM 5.3 Flash".
// This is display-only — request ids always stay untouched.

const NUMERIC = /^\d+(?:[._]\d+)*$/;
const SIZE_TOKEN = /^[a-z]?\d+(?:\.\d+)?b$/i;

// Tokens that must stay upper-case when they appear in a model id.
const ACRONYMS = new Set([
  "ai", "api", "glm", "gpt", "llm", "mcp", "ocr", "oss", "r1", "stt", "tts", "vl", "vlm",
]);

// Org / vendor namespace segments are routing metadata, not part of the model
// name. `zai-org/GLM-5.3-Flash` must read as "GLM 5.3 Flash", never
// "Zai Org GLM 5.3 Flash". A leading `@` segment (Cloudflare `@cf/...`) is a
// routing code as well; models that still carry one are hidden by the pickers.
const ORG_SEGMENTS = new Set([
  "@cf", "@openrouter", "@ai", "accounts", "fireworks", "routers", "models", "publishers",
  "zai-org", "z-ai", "z.ai", "zai", "zhipu",
  "anthropic", "openai", "google", "deepmind", "meta", "meta-llama", "llama",
  "mistralai", "mistral", "xai", "x-ai", "deepseek", "qwen", "alibaba",
  "moonshot", "moonshotai", "kimi", "cohere", "amazon", "aws", "bedrock",
  "microsoft", "azure", "nvidia", "perplexity", "minimax", "bytedance",
  "baidu", "tencent", "stepfun", "nous", "nousresearch",
]);

const ORG_TOKENS = new Set([
  "accounts", "fireworks", "routers", "nvidia", "openai", "google", "meta",
  "anthropic", "mistral", "mistralai", "zai", "zhipu", "deepseek",
]);

const FREE_SUFFIX = /:(?:free|beta|latest|preview|thinking|extended|stable|experimental|batch)$/i;
const FREE_DASH_SUFFIX = /(?:-(?:free|latest|preview|thinking|extended|stable|experimental|batch))+$/i;

/** Routing/org noise removed from a human-facing model label. */
export function cleanModelLabel(raw = "") {
  let parts = String(raw)
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("@") && !ORG_SEGMENTS.has(segment.toLowerCase()));
  // A short leading segment (`lr/`, `oc/`, `cc/`) is the UI provider alias.
  // It is routing metadata too, so the model label never shows it.
  if (parts.length > 1 && /^[a-z0-9]{1,4}$/i.test(parts[0]) && !/^\d/.test(parts[0])) {
    parts = parts.slice(1);
  }
  let value = parts.join("/") || String(raw);
  value = value.replace(FREE_SUFFIX, "").replace(FREE_DASH_SUFFIX, "");
  return value;
}

/** A model that still contains an `@` routing code is not shown at all. */
export function isHiddenModelName(raw = "") {
  return String(raw).split("/").some((segment) => segment.startsWith("@"));
}

/**
 * Category label: the exact model with its effort/tag suffixes removed, so
 * `claude-fable-5`, `claude-fable-5:free` and `claude-fable-5-high` share one
 * category named "Claude Fable 5".
 */
export function modelCategoryName(raw = "") {
  let value = cleanModelLabel(raw);
  value = value.replace(/(?:-(?:high|medium|low|max|xhigh|minimal))$/i, "");
  return prettyModelName(value);
}

function humanizeToken(token) {
  const lower = token.toLowerCase();
  if (SIZE_TOKEN.test(token)) return `${token.slice(0, -1).toUpperCase()}B`;
  if (ACRONYMS.has(lower)) return token.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Human-friendly model name derived from an id.
 *
 * @param {string} raw e.g. "claude-fable-5-1" or "glm-5.3-flash"
 * @returns {string} e.g. "Claude Fable 5.1" or "GLM 5.3 Flash"
 */
export function prettyModelName(raw = "") {
  // Live catalogs sometimes encode a version dot as `p` (`glm-5p3`).
  const tokens = cleanModelLabel(raw)
    .replace(/(\d)p(\d)/gi, "$1.$2")
    .split(/[-_/\s]+/)
    .filter(Boolean);
  // A vendor word that survived as part of a display name (e.g. "Nvidia
  // Nemotron") is still routing metadata, not the model.
  if (tokens.length > 1 && ORG_TOKENS.has(tokens[0].toLowerCase())) tokens.shift();
  const out = [];

  for (const token of tokens) {
    if (NUMERIC.test(token)) {
      const version = token.replace(/[._]/g, ".");
      const lastIndex = out.length - 1;
      // `5` followed by `1` is one version, not two words.
      if (lastIndex >= 0 && NUMERIC.test(out[lastIndex])) {
        out[lastIndex] = `${out[lastIndex]}.${version}`;
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
 * What the playground should show for a combo: the name the user typed, or a
 * pretty derivation of the combo id.
 */
export function comboDisplayLabel(combo) {
  const custom = typeof combo?.displayName === "string" ? combo.displayName.trim() : "";
  if (custom) return custom;
  return prettyModelName(combo?.name || "");
}
