// Re-checks the 1M combo gate the way the fixed code now judges it: only a
// declared number (registry entry or cached upstream catalog) counts, a name
// heuristic does not. Prints how many of the user's 66 seats would still be
// blocked, and what evidence each offender actually has.
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../open-sse/providers/capabilities.js";

// catalogOverride.js imports the "@/lib" webpack alias, so read the cache file it
// is built from directly instead of importing it here.
function readCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".or", "model-catalog.json"), "utf8"));
    return raw?.models || raw || {};
  } catch {
    return {};
  }
}
const CATALOG = readCatalog();
const catalogKeys = Object.keys(CATALOG);

const ALIAS_TO_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]),
);
const LIMIT = 1_000_000;

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const seats = JSON.parse(db.prepare("select models from combos where name = ?").get("claude-opus-5-5").models);
db.close();

function declared(providerId, model) {
  try {
    const entry = (getModelsByProviderId(providerId) || []).find((m) => m.id === model);
    const w = Number(entry?.contextWindow ?? entry?.caps?.contextWindow);
    if (Number.isFinite(w) && w > 0) return { window: w, source: "registry" };
  } catch { /* no static list */ }
  try {
    const key = catalogKeys.find((k) => k === `${providerId}:${model}` || k.endsWith(`:${model}`) || k.includes(model));
    const entry = key ? CATALOG[key] : null;
    const w = Number(entry?.contextWindow ?? entry?.context_window ?? entry?.context ?? entry?.max_input_tokens);
    if (Number.isFinite(w) && w > 0) return { window: w, source: "catalog-cache" };
  } catch { /* nothing cached */ }
  return null;
}

const blocked = [];
let unknown = 0;
for (const seat of seats) {
  const slash = seat.indexOf("/");
  const alias = slash > 0 ? seat.slice(0, slash) : "";
  const model = slash > 0 ? seat.slice(slash + 1) : seat;
  const providerId = ALIAS_TO_ID[alias] || alias || null;
  const evidence = declared(providerId, model) || (providerId ? null : declared(null, model));
  const guess = getCapabilitiesForModel(providerId, model)?.contextWindow;
  if (!evidence) {
    unknown += 1;
    continue; // unknown → allowed, exactly as the fixed gate works
  }
  if (evidence.window < LIMIT) blocked.push({ seat, ...evidence, guess });
}

console.log("catalog cache entries:", catalogKeys.length);
console.log(JSON.stringify({
  seats: seats.length,
  allowedAsUnknown: unknown,
  stillBlockedOnRealEvidence: blocked.length,
  blockedDetail: blocked,
}, null, 2));
