// The skills prompt block — the owner's rule: the router TELLS the model what
// it can reach. Skills (from the GitHub catalog / local install) and the
// locally registered models go into every request's system prompt through the
// same injector the Token Saver prompts use, so a bridge client (Claude Code,
// OpenCode CLI) sees the same surface a direct client does. Fail-open: any
// problem leaves the request untouched.
//
// The block is cached per-process for 60s — chatCore is a hot path and the
// skills list changes rarely. A request that arrives with the injection
// disabled gets null and the dispatcher skips the step entirely.

import { getSettings } from "@/lib/db/repos/settingsRepo.js";

// How many skills the block names. The model needs the menu, not the
// encyclopedia — the full index stays on the skills API.
const MAX_SKILLS = 40;

// One skill's line in the block: name + description from the skill's own
// metadata (never authored here).
function skillLine(skill) {
  const name = String(skill?.name || skill?.dirName || "").trim();
  if (!name) return null;
  const description = String(skill?.description || "").replace(/\s+/g, " ").trim();
  return description ? `- ${name} — ${description}` : `- ${name}`;
}

// One local model's line: registry name + the file kind, so a model knows
// what can be served locally through the llama.cpp/Ollama bridge.
function modelLine(model) {
  const name = String(model?.name || "").trim();
  if (!name) return null;
  const kind = String(model?.path || "").split(".").pop()?.toUpperCase();
  return kind ? `- ${name} (${kind})` : `- ${name}`;
}

/**
 * Build the injectable block. Pure — the dispatcher decides whether it runs.
 *
 * @param {object} args
 * @param {Array} args.skills pipeline entries ({name, description})
 * @param {number} [args.limit] max skills named
 * @param {Array} [args.models] registered local models ({name, path})
 * @returns {string} "" when there is nothing to say
 */
export function buildSkillsPromptBlock({ skills = [], limit = MAX_SKILLS, models = [] } = {}) {
  const skillLines = (Array.isArray(skills) ? skills : [])
    .map(skillLine)
    .filter(Boolean)
    .slice(0, limit);
  const modelLines = (Array.isArray(models) ? models : [])
    .map(modelLine)
    .filter(Boolean);

  if (!skillLines.length && !modelLines.length) return "";

  const parts = [];
  if (skillLines.length) {
    const total = Number(skills?.length) || skillLines.length;
    parts.push(
      "OriginRouter skills available (ask the router's skills API for the full index):",
      skillLines.join("\n"),
    );
    if (total > skillLines.length) {
      parts.push(`… and ${total - skillLines.length} more skills installed.`);
    }
  }
  if (modelLines.length) {
    parts.push(
      "Local models registered on this machine (served through the local engine bridge):",
      modelLines.join("\n"),
    );
  }
  return parts.join("\n");
}

// Per-process cache. Skills/models change rarely; a 60s TTL keeps the hot
// path free of per-request pipeline scans.
let cache = { at: 0, block: "" };

export function resetSkillsPromptCache() {
  cache = { at: 0, block: "" };
}

/**
 * The dispatcher-facing helper: returns the block string when injection is
 * enabled and there is something to say, else null. All failures fail-open.
 */
export async function getSkillsPromptBlock({ maxAgeMs = 60000 } = {}) {
  try {
    const settings = await getSettings();
    const enabled = settings?.skills?.systemPrompt?.enabled !== false; // owner default: ON
    if (!enabled) return null;
    const now = Date.now();
    if (cache.at && now - cache.at < maxAgeMs) return cache.block || null;
    const [{ pipelineStatus }, { listLocalModels }] = await Promise.all([
      import("./index.js"),
      import("@/lib/localModels/registry.js"),
    ]);
    const [{ skills = [] }, models = []] = await Promise.all([
      pipelineStatus().catch(() => ({})),
      listLocalModels().catch(() => []),
    ]);
    const block = buildSkillsPromptBlock({ skills, models });
    cache = { at: now, block };
    return block || null;
  } catch {
    return null;
  }
}
