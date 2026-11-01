// What are the REAL context windows of the seats in the user's claude-opus-5-5
// combo? Compares three sources so the 1M gate can be judged on evidence:
//   1. the capability table the gate uses (open-sse/providers/capabilities.js)
//   2. the upstream model catalog cache in ~/.or (what the providers declared)
//   3. PandaOrchestrator's model cards (its own limits for the same model)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCapabilitiesForModel } from "../open-sse/providers/capabilities.js";
import { PROVIDER_ID_TO_ALIAS, getModelsByProviderId } from "../open-sse/config/providerModels.js";

// src/shared/constants/providers.js imports the "open-sse" webpack alias, which
// plain node cannot resolve; the alias map lives in the registry already.
const ALIAS_TO_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]),
);

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const combo = db.prepare("select * from combos where name = ?").get("claude-opus-5-5");
const seats = combo ? JSON.parse(combo.models || "[]") : [];
console.log("combo seats:", seats.length);

// 2. upstream catalog cache
let catalog = {};
try {
  const raw = fs.readFileSync(path.join(os.homedir(), ".or", "model-catalog.json"), "utf8");
  catalog = JSON.parse(raw);
} catch (error) {
  console.log("catalog cache unreadable:", error.message);
}
const catalogModels = catalog?.models || {};
const catalogEntries = Object.entries(catalogModels);

// 3. Panda cards
let pandaCards = {};
try {
  const res = await fetch("http://127.0.0.1:8765/health", { signal: AbortSignal.timeout(3000) });
  if (res.ok) console.log("panda online");
} catch { console.log("panda offline"); }

const rows = [];
for (const seat of seats) {
  const slash = seat.indexOf("/");
  const alias = slash > 0 ? seat.slice(0, slash) : "";
  const model = slash > 0 ? seat.slice(slash + 1) : seat;
  const providerId = ALIAS_TO_ID[alias] || alias || null;

  const caps = getCapabilitiesForModel(providerId, model);
  const declared = Number.isFinite(caps?.contextWindow) ? caps.contextWindow : null;

  // What does the static registry list for this exact model?
  let registryWindow = null;
  if (providerId) {
    try {
      const list = getModelsByProviderId(providerId) || [];
      const entry = list.find((m) => m.id === model);
      registryWindow = entry?.contextWindow ?? entry?.caps?.contextWindow ?? null;
    } catch { /* registry has no such provider */ }
  }

  // Catalog cache: keyed by "provider:model" or similar; scan for the model id.
  const cacheHit = catalogEntries.find(([key]) => key.endsWith(`:${model}`) || key.includes(model));
  const cacheWindow = cacheHit ? (cacheHit[1]?.contextWindow ?? cacheHit[1]?.context_length ?? null) : null;

  rows.push({ seat, alias, model, providerId, declared, registryWindow, cacheWindow });
}

const pad = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
console.log("\nseat".padEnd(46), "gate(declared)".padEnd(16), "registry".padEnd(14), "catalog-cache");
for (const r of rows) {
  console.log(r.seat.padEnd(46), pad(r.declared).padEnd(16), pad(r.registryWindow).padEnd(14), pad(r.cacheWindow));
}

console.log("\nproviders with active connections serving these model ids (spread check):");
const conns = db.prepare("select id, provider, name from providerConnections where isActive = 1").all();
const byProvider = {};
for (const c of conns) byProvider[c.provider] = (byProvider[c.provider] || 0) + 1;
for (const r of rows) {
  const sameModelElsewhere = conns
    .filter((c) => {
      try {
        return (getModelsByProviderId(c.provider) || []).some((m) => m.id === r.model);
      } catch {
        return false;
      }
    })
    .map((c) => `${PROVIDER_ID_TO_ALIAS[c.provider] || c.provider}(x${byProvider[c.provider]})`);
  console.log(`  ${r.seat.padEnd(44)} also on: ${[...new Set(sameModelElsewhere)].join(", ") || "only this provider"}`);
}
db.close();
