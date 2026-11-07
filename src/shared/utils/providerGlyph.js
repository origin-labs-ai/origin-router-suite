// Letter glyphs and accent colors for providers that have no icon asset —
// chiefly the Hand Picked OpenAI Compatible providers the user configures
// themselves, which never ship a PNG.
//
// The glyph rule (the owner's spec, with examples):
//   NexAPI      → "N"   (a trailing acronym segment collapses to one letter)
//   OrcaRouter  → "OR"  (two real word segments → first letter of each)
//   Orca-Router → "OR"  (same, hyphen-separated)
//   "Orca Route"→ "OR"  (same, space-separated)
//   ollama      → "O"   (single word → first letter)
//
// Colors are deterministic per provider id: the same provider always renders
// the same accent, different providers diverge. The palette is curated for
// contrast on both light and dark surfaces.

// Curated palette — checked for readability as a tinted background with the
// color itself as text, on both light and dark surfaces.
const PALETTE = [
  "#2B7FFF", // blue
  "#10A37F", // emerald
  "#8B5CF6", // violet
  "#F59E0B", // amber
  "#EC4899", // pink
  "#14B8A6", // teal
  "#F97316", // orange
  "#6366F1", // indigo
  "#22C55E", // green
  "#E11D48", // rose
  "#0EA5E9", // sky
  "#A855F7", // purple
  "#D946EF", // fuchsia
  "#84CC16", // lime
  "#EF4444", // red
  "#06B6D4", // cyan
];

// Split a display name into word segments: camelCase / PascalCase boundaries,
// hyphens, underscores and spaces all break a word. Digits are dropped.
export function splitNameSegments(name) {
  return String(name || "")
    .replace(/([a-z])([A-Z])/g, "$1\u0000$2") // camel boundary marker
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\u0000$2") // acronym→Word boundary (NexAPI → Nex|API)
    .split(/[\u0000\-\_\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The letter mark for a provider name, 1-2 uppercase letters.
export function providerGlyph(name) {
  const segments = splitNameSegments(name);
  if (segments.length === 0) return "?";

  // Any non-initial segment that is a pure acronym (API, AI, LLM, 5G…) makes
  // the mark a single letter — the acronym is not an independent word, it is
  // part of one brand ("NexAPI" is "Nex-API", brand "Nex").
  const acronymTail = segments
    .slice(1)
    .some((seg) => seg.length >= 2 && seg === seg.toUpperCase() && /^[A-Z]+$/.test(seg));
  if (acronymTail || segments.length === 1) {
    return segments[0].charAt(0).toUpperCase();
  }

  // Two real words → first letter of each.
  return (segments[0].charAt(0) + segments[1].charAt(0)).toUpperCase();
}

// FNV-1a over the id, mapped into the palette. Deterministic, dependency-free.
export function providerAccentColor(id) {
  const s = String(id || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// Convenience wrapper for the compatible-provider cards: everything the card
// needs in one call.
export function providerGlyphTheme(id, name) {
  return {
    textIcon: providerGlyph(name || id),
    color: providerAccentColor(id),
  };
}
