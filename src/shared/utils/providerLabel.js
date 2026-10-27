import { AI_PROVIDERS } from "@/shared/constants/providers";

/**
 * Turn a provider id into something readable when nothing better is known,
 * e.g. "openai-compatible-chat-0a2a" -> "Openai Compatible Chat 0a2a".
 */
export function humanizeProviderId(value = "") {
  return String(value)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || "Unknown";
}

/**
 * Build an id -> user-visible name map from /api/provider-nodes rows.
 * Custom (openai/anthropic compatible) providers are named by the user, so this
 * map is the only place their chosen name survives.
 */
export function buildProviderNameMap(nodes) {
  const map = {};
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.id) map[node.id] = node.name || "";
  }
  return map;
}

/**
 * Single source of truth for provider labels across the dashboard.
 *
 * A connection name is an ACCOUNT label ("Account 1", an email, "local"), never
 * the provider identity. So the order is:
 *   1. user-authored node name (custom OpenAI/Anthropic-compatible providers)
 *   2. node name snapshot stored on the connection
 *   3. built-in product name (OpenRouter, Antigravity, Gemini, …)
 *   4. connection name (only when the provider itself is unknown)
 *   5. humanized id
 *
 * @param {string} providerId
 * @param {{ nodeNames?: Record<string, string>, connection?: object, fallback?: string }} [options]
 */
export function resolveProviderLabel(providerId, options = {}) {
  const { nodeNames, connection, fallback } = options;
  const nodeName = typeof nodeNames?.[providerId] === "string" ? nodeNames[providerId].trim() : "";
  if (nodeName) return nodeName;

  // Compatible-provider connections snapshot the node name at creation time.
  const snapshotName = typeof connection?.providerSpecificData?.nodeName === "string"
    ? connection.providerSpecificData.nodeName.trim()
    : "";
  if (snapshotName) return snapshotName;

  const builtInName = typeof AI_PROVIDERS?.[providerId]?.name === "string"
    ? AI_PROVIDERS[providerId].name.trim()
    : "";
  if (builtInName) return builtInName;

  const connectionName = typeof connection?.name === "string" ? connection.name.trim() : "";
  if (connectionName) return connectionName;

  if (fallback) return fallback;
  return humanizeProviderId(providerId);
}
