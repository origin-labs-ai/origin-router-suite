// Ground truth for the 13 seats the combo gate flagged.
//
// Prints, per seat: the number the capability table reports, where that number
// came from (a declared upstream catalog record vs a name-pattern default), and
// every context-ish field the raw upstream catalog carries for that model id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCapabilitiesForModel } from "../open-sse/providers/capabilities.js";
import { PROVIDER_ID_TO_ALIAS } from "../open-sse/config/providerModels.js";

const ALIAS_TO_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]),
);
const FLAGGED = [
  "Intern Atria Dawn", "Atria Dawn", "V4.1 Flash", "Hy4", "Qfmodel",
  "~deepseek Deepseek Flash", "~deepseek Deepseek Pro", "Chat",
  "Sakana Fugu Max", "Sakana Fugu Ultra", "Sakana Fugu Ultra V2",
  "Qwen3.8 Omni Flash", "Hy4",
];

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const seats = JSON.parse(db.prepare("select models from combos where name=?").get("claude-opus-5-5").models);
let models = [];
try {
  models = db.prepare("select provider, model, name, caps from customModels").all();
} catch {
  // Custom models live in the kv store as one row per "<alias>|llm" entry.
  try {
    const kv = db.prepare("select key, value from kv where key like '%|llm'").all();
    models = kv.map((row) => {
      const alias = row.key.split("|")[0];
      let parsed = {};
      try { parsed = JSON.parse(row.value) || {}; } catch { parsed = {}; }
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      return entries.map((entry) => ({
        provider: alias,
        model: entry.id || entry.model || "",
        name: entry.name || entry.id || "",
        caps: entry.caps || null,
      }));
    }).flat();
  } catch { models = []; }
}
const nodes = (() => { try { return db.prepare("select id, name, prefix from providerNodes").all(); } catch { return []; } })();
db.close();

// 1. Which seats do those display names belong to?
console.log("=== flagged names -> combo seats ===");
const nodeByProvider = new Map(nodes.map((n) => [n.id, n]));
for (const flagged of [...new Set(FLAGGED)]) {
  const clean = flagged.toLowerCase().replace(/\s+/g, "");
  const hits = [];
  for (const seat of seats) {
    const slash = seat.indexOf("/");
    const model = (slash > 0 ? seat.slice(slash + 1) : seat).toLowerCase().replace(/[^\w]/g, "");
    const alias = slash > 0 ? seat.slice(0, slash) : "";
    const node = nodeByProvider.get(ALIAS_TO_ID[alias] || alias);
    const nodeName = (node?.name || alias || "").toLowerCase().replace(/\s+/g, "");
    if (model.includes(clean) || (nodeName + model).includes(clean)) hits.push(seat);
  }
  // custom model rows carry the pretty name the dashboard showed
  const custom = models.filter((m) => (m.name || "").toLowerCase().replace(/\s+/g, "").includes(clean));
  console.log(`  ${flagged.padEnd(24)} seats=[${hits.join(", ")}]${custom.length ? " customRows=" + custom.length : ""}`);
}

// 2. What does the capability table say, and is it a real record or a guess?
console.log("\n=== capability table per flagged seat ===");
const seen = new Set();
for (const flagged of [...new Set(FLAGGED)]) {
  const clean = flagged.toLowerCase().replace(/\s+/g, "");
  for (const seat of seats) {
    const slash = seat.indexOf("/");
    const alias = slash > 0 ? seat.slice(0, slash) : "";
    const model = slash > 0 ? seat.slice(slash + 1) : seat;
    if (seen.has(seat)) continue;
    const node = nodeByProvider.get(ALIAS_TO_ID[alias] || alias);
    const label = ((node?.name || alias) + " " + model).toLowerCase().replace(/\s+/g, "");
    if (!label.includes(clean) && !model.toLowerCase().replace(/[^\w]/g, "").includes(clean)) continue;
    seen.add(seat);
    const caps = getCapabilitiesForModel(ALIAS_TO_ID[alias] || alias, model);
    console.log(`  ${seat.padEnd(46)} ${JSON.stringify({ contextWindow: caps?.contextWindow ?? null })}`);
  }
}

// 3. Raw upstream catalog: the only place a provider's real number can appear.
const rawPath = path.join(os.homedir(), ".or", "model-catalog-raw.json");
const nicePath = path.join(os.homedir(), ".or", "model-catalog.json");
for (const file of [nicePath, rawPath]) {
  if (!fs.existsSync(file)) { console.log(`\n(missing ${path.basename(file)})`); continue; }
  const text = fs.readFileSync(file, "utf8");
  console.log(`\n=== ${path.basename(file)} (${(text.length / 1048576).toFixed(1)} MB) ===`);
  for (const needle of ["Atria", "hy4", "fugu", "omni", "qfmodel", "deepseek-pro-latest"]) {
    const re = new RegExp(`[^{}]*${needle}[^{}]*`, "gi");
    const matches = (text.match(re) || []).slice(0, 3);
    for (const m of matches) {
      const trimmed = m.replace(/\s+/g, " ").trim().slice(0, 220);
      if (trimmed.includes("context") || trimmed.includes("token") || trimmed.includes("length")) {
        console.log(`  [${needle}] ${trimmed}`);
      }
    }
  }
}
