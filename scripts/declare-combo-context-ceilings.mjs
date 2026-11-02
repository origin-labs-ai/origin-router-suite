// Writes the owner's declared context window into the gateway's own custom model
// rows, for every model referenced by a combo.
//
// Why here: the 200K/128K/330K numbers were never the models' limits. Custom rows
// carry no caps.contextWindow at all, so each surface fell back to the capability
// table (family patterns plus a 200K floor) and rendered that as a limit. Fixing
// the row fixes every reader at once — /v1/models (what Claude Code and Codex
// list), the dashboard pickers, the provider pages and combo aggregation.
//
// Rows that already declare a window are left untouched; only unknown ones are set.
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX = 1_048_576;
const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"));

const seats = new Set();
for (const row of db.prepare("select models from combos").all()) {
  try {
    for (const seat of JSON.parse(row.models || "[]")) {
      if (typeof seat !== "string") continue;
      const slash = seat.indexOf("/");
      if (slash > 0) seats.add(`${seat.slice(0, slash)}|${seat.slice(slash + 1)}`);
      else seats.add(`|${seat}`);
    }
  } catch { /* malformed combo payload */ }
}

const rows = db.prepare("select key, value from kv where key like '%|llm'").all();
const update = db.prepare("update kv set value = ? where key = ?");
let changed = 0;
const touched = [];

for (const row of rows) {
  let parsed;
  try { parsed = JSON.parse(row.value); } catch { continue; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const alias = row.key.split("|")[0];
  let dirty = false;

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
    if (!seats.has(`${alias}|${entry.id}`)) continue;
    const existing = Number(entry.caps?.contextWindow ?? entry.contextWindow);
    if (Number.isFinite(existing) && existing > 0) continue; // already declared
    entry.caps = { ...(entry.caps || {}), contextWindow: MAX };
    delete entry.contextWindow;
    dirty = true;
    touched.push(`${alias}/${entry.id}`);
  }

  if (dirty) {
    update.run(JSON.stringify(parsed), row.key);
    changed += 1;
  }
}

console.log(`combo-referenced seats: ${seats.size}`);
console.log(`kv rows updated: ${changed}, models declared at ${MAX.toLocaleString("en-US")}: ${touched.length}`);
for (const name of touched.slice(0, 25)) console.log("  + " + name);
if (touched.length > 25) console.log(`  ... ${touched.length - 25} more`);
db.close();
