// Declares the maximum ceiling (1,048,576) for every combo seat whose context
// window no provider actually declared, and writes ~/.or/context-ceilings.json.
//
// Rationale: an unknown window is not a small window. These seats are custom
// aggregator rows whose upstream never reported a limit, and the owner's rule is
// "give the max of the max" rather than inherit the router's name-heuristic
// guess (200K/128K) as if it were a hardware limit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROVIDER_ID_TO_ALIAS } from "../open-sse/config/providerModels.js";
import { getModelsByProviderId } from "../open-sse/config/providerModels.js";

const MAX = 1_048_576;
const ALIAS_TO_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]),
);

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const combos = db.prepare("select name, models from combos").all();
db.close();

function declared(providerId, model) {
  if (!providerId) return false;
  try {
    const entry = (getModelsByProviderId(providerId) || []).find((m) => m.id === model);
    return Number.isFinite(Number(entry?.contextWindow ?? entry?.caps?.contextWindow));
  } catch {
    return false;
  }
}

const ceilingsPath = path.join(os.homedir(), ".or", "context-ceilings.json");
let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(ceilingsPath, "utf8")) || {};
} catch { existing = {}; }

const written = [];
for (const combo of combos) {
  let seats = [];
  try { seats = JSON.parse(combo.models || "[]"); } catch { continue; }
  for (const seat of seats) {
    if (typeof seat !== "string" || !seat.includes("/")) continue;
    const alias = seat.slice(0, seat.indexOf("/"));
    const model = seat.slice(seat.indexOf("/") + 1);
    const providerId = ALIAS_TO_ID[alias] || alias;
    if (declared(providerId, model)) continue; // a real number exists; leave it alone
    if (!existing[seat]) {
      existing[seat] = MAX;
      written.push(seat);
    }
  }
}

fs.mkdirSync(path.dirname(ceilingsPath), { recursive: true });
fs.writeFileSync(ceilingsPath, JSON.stringify(existing, null, 2));
console.log(`wrote ${ceilingsPath}`);
console.log(`newly declared at ${MAX.toLocaleString("en-US")}: ${written.length} seats (total entries now ${Object.keys(existing).length})`);
for (const seat of written.slice(0, 30)) console.log("  + " + seat);
