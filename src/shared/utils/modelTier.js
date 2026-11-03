// Model tiers and families — the two classes the owner named, applied to every
// model in the catalog, not just the examples he quoted:
//
//   pro    the heavy end: Opus, Fable, Sol, Sol Pro, DeepSeek-V4-Pro, Kimi-K3,
//          GLM-5.3, Qwen-3.8-Max … anything that is not a reduced variant
//   flash  the reduced variants: Qwen-3.8-Flash, MiMo-V2.6-Flash,
//          MiniMax-M3.1-Flash, GLM-5.3-Flash, DeepSeek-V4-Flash / -V4.1-Flash /
//          -V4.1-Flash-1017, Qoder's qfmodel …
//     └── subcategory per family, e.g. Flash → DeepSeek-Flash, Flash → GLM-Flash
//
// Why the router needs this: "best models should get used" and "no seat left idle"
// pull in opposite directions. Tier + family is what lets the brain spend hard work
// on the heavy end, keep bulk traffic on the flash pool, and still rotate inside
// each pool so no provider's quota is drained and no model sits unused.
//
// Classification is done on the model's identity (its catalog name when the provider
// supplies one), so a prefix, a suffix, a `TEE`, an effort level or a build number
// never changes the answer: `glm-5.3-flash-tee` and `GLM-5.3-Flash:batch` are both
// GLM / flash.

import { modelGroupKey, prettyModelName } from "./modelDisplayName.js";

export const TIER_PRO = "pro";
export const TIER_FLASH = "flash";

// Words that mark a reduced variant. Everything else is the heavy end of its line.
const FLASH_WORDS = new Set([
  "flash", "lite", "mini", "nano", "small", "tiny", "turbo", "air", "express",
  "economy", "economics", "cheap", "fast", "swift", "quick", "basic", "free",
]);

// Vendor/family spellings folded onto one family name, in display case.
const FAMILY_NAMES = new Map([
  ["deepseek", "DeepSeek"], ["deep", "DeepSeek"], ["dmodel", "DeepSeek"], ["dfmodel", "DeepSeek"],
  ["glm", "GLM"], ["gmodel", "GLM"], ["gfmodel", "GLM"], ["chatglm", "GLM"], ["zhipu", "GLM"],
  ["qwen", "Qwen"], ["qwq", "Qwen"], ["qmodel", "Qwen"], ["qfmodel", "Qwen"],
  ["kimi", "Kimi"], ["kmodel", "Kimi"], ["moonshot", "Kimi"],
  ["minimax", "MiniMax"], ["mm", "MiniMax"], ["mmodel", "MiniMax"],
  ["claude", "Claude"], ["opus", "Claude"], ["sonnet", "Claude"], ["haiku", "Claude"], ["fable", "Claude"],
  ["gpt", "GPT"], ["sol", "GPT"], ["o1", "GPT"], ["o3", "GPT"], ["codex", "GPT"],
  ["gemini", "Gemini"], ["gemma", "Gemini"], ["antigravity", "Gemini"],
  ["mimo", "MiMo"], ["mistral", "Mistral"], ["magistral", "Mistral"],
  ["llama", "Llama"], ["grok", "Grok"], ["ernie", "ERNIE"], ["doubao", "Doubao"],
  ["hunyuan", "Hunyuan"], ["hy", "Hunyuan"], ["nemotron", "Nemotron"], ["phi", "Phi"],
  ["step", "Step"], ["atria", "Intern"], ["fugu", "Fugu"], ["sonus", "Sonus"],
  ["cantus", "Cantus"], ["seed", "Seed"], ["r1", "DeepSeek"], ["arcee", "Arcee"],
  ["nova", "Nova"], ["sonar", "Perplexity"], ["perplexity", "Perplexity"],
]);

function familyOf(tokens) {
  const first = String(tokens[0] || "").toLowerCase();
  if (FAMILY_NAMES.has(first)) return FAMILY_NAMES.get(first);
  // `hy3`, `k3`, `glm5` style: match the leading letters of the first token.
  const lead = first.match(/^[a-z]+/)?.[0] || "";
  if (FAMILY_NAMES.has(lead)) return FAMILY_NAMES.get(lead);
  return lead ? lead.charAt(0).toUpperCase() + lead.slice(1) : "";
}

/**
 * Tier, family and category path for one model.
 *
 * @param {string} seatOrId `provider/model` or a bare id
 * @param {string} [catalogName] the provider's own name for it, when known
 * @returns {{ tier: string, family: string, category: string, subcategory: string, rank: number, label: string }}
 */
export function modelTier(seatOrId, catalogName = "") {
  const source = catalogName || seatOrId;
  const key = modelGroupKey(source);
  const tokens = key ? key.split("-").filter(Boolean) : [];
  const label = prettyModelName(source);

  // A flash word anywhere in the identity means a reduced variant. `pro` inside a
  // flash name (`hy3-flash-pro`) still reads as flash: the variant is the point.
  const isFlash = tokens.some((token) => FLASH_WORDS.has(token));
  const family = familyOf(tokens);

  const tier = isFlash ? TIER_FLASH : TIER_PRO;
  // Category is the class the owner named; the subcategory groups a class by family
  // so "Flash" contains "DeepSeek-Flash", "GLM-Flash", "Qwen-Flash" …
  const category = tier === TIER_FLASH ? "Flash" : "Pro";
  const subcategory = family ? `${category} / ${family}${isFlash ? "-Flash" : ""}` : category;

  return {
    tier,
    family,
    category,
    subcategory,
    // Ordering weight the router uses: heavy models first.
    rank: tier === TIER_FLASH ? 1 : 0,
    label,
  };
}

/** Group catalog entries by category → subcategory for a picker or a report. */
export function groupByTier(entries, nameOf = () => "") {
  const tree = new Map();
  for (const entry of entries) {
    const seat = typeof entry === "string" ? entry : entry?.seat || entry?.value || entry?.id;
    if (!seat) continue;
    const info = modelTier(seat, nameOf(seat));
    if (!tree.has(info.category)) tree.set(info.category, new Map());
    const sub = tree.get(info.category);
    if (!sub.has(info.subcategory)) sub.set(info.subcategory, []);
    sub.get(info.subcategory).push({ seat, ...info });
  }
  return tree;
}
