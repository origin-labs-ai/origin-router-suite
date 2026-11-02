// Writes the owner's declared context window into the gateway's own custom model
// rows, for every model referenced by a combo.
//
// Why here: the 200K/128K/330K/262K numbers were never the models' limits. Custom
// rows carried no caps.contextWindow, so every surface fell back to the capability
// table (family patterns plus a 200K floor) and rendered that as a cap. Fixing the
// row fixes every reader at once — /v1/models (what Claude Code and Codex list),
// the dashboard pickers, the provider pages and combo aggregation.
//
// The owner's rule is "max of the max" for these seats, so combo-referenced rows
// are set unconditionally; whatever was there before is written to
// ~/.or/context-ceilings-backup.json so any of it can be put back.
import fs from "node:fs";
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

// Previous values, so any single seat can be put back exactly as it was.
const backupPath = path.join(os.homedir(), ".or", "context-ceilings-backup.json");
let backup = {};
try { backup = JSON.parse(fs.readFileSync(backupPath, "utf8")) || {}; } catch { backup = {}; }

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
    const seat = `${alias}/${entry.id}`;
    const previous = entry.caps?.contextWindow ?? entry.contextWindow ?? null;
    if (!(seat in backup)) backup[seat] = previous;
    if (Number(entry.caps?.contextWindow) === MAX && !("contextWindow" in entry)) {
      continue; // already at the declared max
    }
    entry.caps = { ...(entry.caps || {}), contextWindow: MAX };
    delete entry.contextWindow;
    dirty = true;
    touched.push(seat);
  }

  if (dirty) {
    update.run(JSON.stringify(parsed), row.key);
    changed += 1;
  }
}

// The ceiling file carries the same declaration for seats that are not custom rows
// (static catalog models), so both readers agree.
const ceilingsPath = path.join(os.homedir(), ".or", "context-ceilings.json");
let ceilings = {};
try { ceilings = JSON.parse(fs.readFileSync(ceilingsPath, "utf8")) || {}; } catch { ceilings = {}; }
for (const seatKey of seats) {
  const seat = seatKey.replace("|", "/");
  if (!seat.includes("/")) continue;
  if (!(seat in ceilings)) {
    if (!(seat in backup)) backup[seat] = ceilings[seat] ?? null;
    ceilings[seat] = MAX;
  }
}
fs.writeFileSync(ceilingsPath, `${JSON.stringify(ceilings, null, 2)}\n`);
fs.writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`);

console.log(`combo-referenced seats: ${seats.size}`);
console.log(`kv rows updated: ${changed}, models declared at ${MAX.toLocaleString("en-US")}: ${touched.length}`);
console.log(`ceilings file entries: ${Object.keys(ceilings).length}, backup kept: ${Object.keys(backup).length}`);
for (const name of touched.slice(0, 25)) console.log("  + " + name);
if (touched.length > 25) console.log(`  ... ${touched.length - 25} more`);
db.close();
