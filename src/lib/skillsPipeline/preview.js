// Preview text helpers for the Skills page cards — PURE string logic, no I/O,
// so both the local catalog and the GitHub source render previews through the
// exact same code path (and the unit tests can pin the behavior).
//
// Policy, in the pipeline's voice: skill markdown is DATA. We never author
// descriptions and never parse markdown — the preview is the file's own
// opening text, lightly cleaned for one-line display:
//   1. the YAML-ish frontmatter block is metadata, not prose → stripped
//      (parseSkillMd from index.js already knows how, fail-open),
//   2. every whitespace run (newlines, indents, lists) collapses to one space,
//      so a card preview is genuinely one line-ish string,
//   3. truncated at `limit` chars on a word boundary, "…" appended ONLY when
//      something was actually cut.

import { parseSkillMd } from "./index.js";

// The card preview length. Short enough to stay "one-line-ish" inside a wide
// card, long enough to say what the skill does. The Read modal asks for more.
export const CARD_PREVIEW_CHARS = 280;

// Hard cap for any preview request (route-level guard: a caller can ask for a
// bigger modal text, but never for the whole file through this surface).
export const PREVIEW_MAX_CHARS = 4000;

// Cut `text` to at most `limit` chars, preferring a word boundary: if the cut
// lands mid-word, walk back to the last space so the ellipsis never splits a
// word (a preview ending in "conne…" reads broken; "connection…" reads fine).
export function wordSafeSlice(text, limit) {
  const raw = String(text ?? "");
  if (raw.length <= limit) return raw;
  const head = raw.slice(0, limit);
  // Only bother walking back when the next char continues a word (letter or
  // digit); a cut that already lands on whitespace/punctuation is a clean
  // boundary as-is.
  if (/[\p{L}\p{N}]/u.test(raw[limit] || "")) {
    const lastSpace = head.lastIndexOf(" ");
    // Keep at least half the budget — a single very long token (URL, hash)
    // must not collapse the preview to nothing.
    if (lastSpace > limit / 2) return head.slice(0, lastSpace);
  }
  return head;
}

function cutPreview(text, limit) {
  const max = Math.max(1, Math.min(Number(limit) || CARD_PREVIEW_CHARS, PREVIEW_MAX_CHARS));
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return { preview: "", truncated: false };
  const cut = wordSafeSlice(flat, max);
  return { preview: cut, truncated: cut.length < flat.length };
}

/**
 * Build a display preview from a SKILL.md's raw text.
 *
 * @param {string} text raw SKILL.md contents
 * @param {number} limit max chars before truncation (route caps this)
 * @returns {{ preview: string, truncated: boolean }}
 *   `preview` is the cleaned opening text; `truncated` is true iff the source
 *   text had more to say than the limit allowed (drives the "…" suffix).
 */
export function skillPreview(text, limit = CARD_PREVIEW_CHARS) {
  // Fail-open: no frontmatter / unterminated frontmatter → parseSkillMd hands
  // back the whole text as body, which is exactly what we want here.
  return cutPreview(parseSkillMd(String(text ?? "")).body, limit);
}

// The display form: preview text plus the ellipsis when content was cut. The
// task contract is explicit — previews end with "…", never mid-sentence dots.
export function previewWithEllipsis(text, limit = CARD_PREVIEW_CHARS) {
  const { preview, truncated } = skillPreview(text, limit);
  return truncated ? `${preview}…` : preview;
}

// A YAML block marker (`>-`, `|`, …) is a parsing artifact, not prose — the
// prompt block already refuses it, and a card must not show it either.
function usableDescription(value) {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return /^[|>][-+]?$/.test(flat) ? "" : flat;
}

/**
 * The skill's own frontmatter description, cleaned for one-line display.
 * Empty when the file has no usable description — callers fall back to the
 * body preview rather than inventing copy.
 */
export function skillDescription(text) {
  return usableDescription(parseSkillMd(String(text ?? "")).description);
}

/**
 * The card's text: the frontmatter description when the skill has one, else
 * the opening body prose. Same truncation policy as every other preview, so a
 * card ending in "…" always means content was actually cut.
 */
export function skillCardText(text, limit = CARD_PREVIEW_CHARS) {
  const parsed = parseSkillMd(String(text ?? ""));
  const sourceText = usableDescription(parsed.description) || parsed.body;
  const { preview, truncated } = cutPreview(sourceText, limit);
  return truncated ? `${preview}…` : preview;
}
