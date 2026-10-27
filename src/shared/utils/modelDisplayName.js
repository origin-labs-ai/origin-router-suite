// Model ids carry version digits in machine form: `claude-fable-5-1`,
// `glm-5.3-flash`. Humans read those as "Claude Fable 5.1" and "GLM 5.3 Flash".
// This is display-only — request ids always stay untouched.

const NUMERIC = /^\d+(?:[._]\d+)*$/;

// Tokens that must stay upper-case when they appear in a model id.
const ACRONYMS = new Set([
  "ai", "api", "glm", "gpt", "llm", "mcp", "ocr", "r1", "stt", "tts", "vl", "vlm",
]);

function humanizeToken(token) {
  const lower = token.toLowerCase();
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
  const tokens = String(raw).split(/[-_/\s]+/).filter(Boolean);
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
