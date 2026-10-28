// Single source of truth for where the Claude surfaces send inference.
// Everything stays on the local OriginRouter; there is no fallback host.
export const ORIGIN_CHAT_ENDPOINT = "/api/dashboard/chat/completions";
export const ORIGIN_BASE_URL = "http://localhost:20128";
export const ORIGIN_COMBO_PREFIX = "claude-";

export function isClaudeCombo(name) {
  return typeof name === "string" && name.startsWith(ORIGIN_COMBO_PREFIX);
}

export function thinkingPayload({ thinking, effort }) {
  if (!thinking) return {};
  return {
    reasoning_effort: effort,
    thinking: {
      type: "enabled",
      budget_tokens: effort === "max" ? 32000 : 8000,
    },
  };
}
