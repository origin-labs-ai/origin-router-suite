// Provider icon paths under /public/providers.
// Alias related brands; resolution is stateless.
//
// There is deliberately NO session-wide "missing" cache here anymore. The old
// Set remembered a single 404 for the whole browser session — one gateway
// restart under an open tab painted every healthy provider as a letter glyph
// until a hard reload, which read as "the icons broke". Per-mount misses now
// cost at most one retry (ProviderIcon retries once with a cache-buster), so
// a truly absent asset shows its glyph, and everything else keeps its image.

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "ollama-search": "ollama",
  // MiniMax Code rides the existing MiniMax brand mark
  "minimax-code": "minimax",
  "minimax-code-global": "minimax",
  // Zen is the same opencode.ai brand
  "opencode-zen": "opencode",
  // Web-cookie variants ride their brand's existing mark
  "deepseek-web": "deepseek",
  "muse-web": "muse",
  "gemini-web": "gemini",
  "chatgpt-web": "openai",
};

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  return providerId.trim().toLowerCase();
}

/** Resolve icon file id (after alias). Empty when the id itself is empty. */
export function resolveProviderIconId(providerId) {
  const id = normalizeId(providerId);
  if (!id) return "";
  return ICON_ALIASES[id] || id;
}

/** `/providers/{id}.png` or null when no id was given. */
export function getProviderIconSrc(providerId) {
  const id = resolveProviderIconId(providerId);
  return id ? `/providers/${id}.png` : null;
}

/** Kept for call-site compatibility; the miss cache is gone, so this is a no-op. */
export function markProviderIconMissing() {}
