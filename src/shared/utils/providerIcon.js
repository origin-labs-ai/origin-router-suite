// Provider icon paths under /public/providers.
//
// The folder is three shelves, not one format: our PNG set, the brand SVG
// library, and fetched .ico marks for the long tail. Guessing ".png" is how a
// provider that owns a perfectly good logo used to render as a letter glyph -
// the request 404'd and the component gave up. So resolution reads
// providerIconManifest.json (generated from the folder by
// `npm run gen:icons`) and returns the extension that is actually on disk.
//
// Alias related brands. There is deliberately no session-wide "missing"
// cache: one restart-window 404 must never paint a healthy provider as a
// glyph for the rest of the browser session.
import manifest from "./providerIconManifest.json";

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
  // Brand families under one logo
  "kimi-code": "kimi-coding",
  "alibaba-cloud": "alibaba",
  "ollama-cloud": "ollama",
  "friendliai": "friendli",
  "inference-net": "inference",
  "qwencloud": "qwen",
  "qwencloud-coding": "qwen",
  "lambda-ai": "lambda",
};

/**
 * The extension ladder for an id the manifest does not know. An id that lands
 * here was added without regenerating the manifest, so the component probes
 * instead of guessing once and giving up.
 */
export const ICON_EXTENSIONS = ["png", "svg", "ico", "webp", "jpg", "jpeg"];

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

/** The extension the id actually ships with, or "" when no asset exists. */
export function resolveProviderIconExtension(providerId) {
  const id = resolveProviderIconId(providerId);
  return id ? manifest[id] || "" : "";
}

/** `/providers/{id}.{ext}` for the format on disk; null when there is no id. */
export function getProviderIconSrc(providerId) {
  const id = resolveProviderIconId(providerId);
  if (!id) return null;
  const ext = manifest[id];
  if (!ext) return null;
  return `/providers/${id}.${ext}`;
}

/**
 * Ordered sources to try for one icon slot: the on-disk format first, then the
 * rest of the ladder for the case where the manifest is stale. Empty for an
 * unknown id, which is what makes the caller render the letter glyph.
 */
export function getProviderIconCandidates(providerId) {
  const id = resolveProviderIconId(providerId);
  if (!id) return [];
  const known = manifest[id];
  const ladder = known ? [known, ...ICON_EXTENSIONS.filter((ext) => ext !== known)] : ICON_EXTENSIONS;
  return ladder.map((ext) => `/providers/${id}.${ext}`);
}
