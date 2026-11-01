import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { getModelsByProviderId } from "../open-sse/config/providerModels.js";

const file = path.join(os.homedir(), ".or", "db", "data.sqlite");
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare("select id, provider, name from providerConnections where isActive=1").all();
db.close();

const providers = [...new Set(rows.map((r) => r.provider))];
let total = 0;
const per = [];
const seen = new Map();
for (const provider of providers) {
  let models = [];
  try {
    models = getModelsByProviderId(provider) || [];
  } catch (e) {
    console.log("ERR", provider, e.message);
  }
  total += models.length;
  per.push({ provider, n: models.length });
  for (const m of models) if (!seen.has(m.id)) seen.set(m.id, new Set());
}
per.sort((a, b) => b.n - a.n);
console.log("connections", rows.length, "providers", providers.length, "static rows", total, "unique model ids", seen.size);
console.log(per.map((p) => `${p.provider}:${p.n}`).join("  "));
const ag = getModelsByProviderId("antigravity");
console.log("antigravity models", ag.length, ag.slice(0, 6).map((m) => m.id).join(", "));
