// Generate PandaOrchestrator model cards for the seats of ONE combo
// (claude-opus-5-5), and nothing else.
//
// Why cards are needed: Panda only scores models it has a card for, so the ~66
// aggregator seats of this combo used to fall out of its ranking as
// `unknown_model` and were only tried by our local order. One card per seat lets
// Panda rank the whole combo by P(success)/cost/latency for real.
//
// Honesty rules baked in:
//   • card `model` is exactly the seat string the router sends (`alias/model`),
//     which is what Panda resolves a pool entry against; `id` is a filesystem-safe
//     slug because card ids may not contain "/".
//   • skills are deliberately mid-scale with a large standard error, and
//     provenance says "estimated": no measured benchmark exists for these seats,
//     so the card must not pretend otherwise.
//   • cost comes from OriginRouter's own pricing table when present, else 0
//     (these are free-tier seats), never invented.
//   • context limit comes from ~/.or/context-ceilings.json (the owner's
//     declaration) or the provider's declared number, not from a name guess.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCapabilitiesForModel } from "../open-sse/providers/capabilities.js";
import { PROVIDER_ID_TO_ALIAS } from "../open-sse/config/providerModels.js";
import { getModelsByProviderId } from "../open-sse/config/providerModels.js";

const COMBO = process.argv[2] || "claude-opus-5-5";
const CARDS_DIR = process.argv[3]
  || "C:\\Users\\thaku\\Tools\\PandaOrchestrator\\cards";
const CEILING_DEFAULT = 1_048_576;
const ALIAS_TO_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]),
);
const slug = (value) => String(value).toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 72);

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const comboRow = db.prepare("select models from combos where name = ?").get(COMBO);
if (!comboRow) { console.error(`no combo named ${COMBO}`); process.exit(1); }
const seats = [...new Set(JSON.parse(comboRow.models || "[]").filter((s) => typeof s === "string" && s.includes("/")))];

let pricing = [];
try { pricing = db.prepare("select * from pricing").all(); } catch { pricing = []; }
let nodeNames = new Map();
try {
  nodeNames = new Map(db.prepare("select id, name from providerNodes").all().map((n) => [n.id, n.name]));
} catch { nodeNames = new Map(); }
db.close();

let ceilings = {};
try {
  ceilings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".or", "context-ceilings.json"), "utf8")) || {};
} catch { ceilings = {}; }

function lookupCost(alias, providerId, model) {
  const candidates = new Set([`${alias}/${model}`, `${providerId}/${model}`, model]);
  for (const row of pricing) {
    const haystack = Object.entries(row)
      .filter(([, value]) => typeof value === "string")
      .map(([, value]) => value);
    const keys = Object.keys(row);
    for (const want of candidates) {
      if (!haystack.some((text) => text === want || text.endsWith(want))) continue;
      const num = (names) => {
        for (const name of names) {
          const key = keys.find((k) => k.toLowerCase() === name);
          if (key && Number.isFinite(Number(row[key]))) return Number(row[key]);
        }
        return null;
      };
      const input = num(["inputpermillion", "input_per_million", "input", "prompt", "priceinput", "inputprice"]);
      const output = num(["outputpermillion", "output_per_million", "output", "completion", "priceoutput", "outputprice"]);
      if (input != null || output != null) {
        return { input: input ?? 0, output: output ?? 0, source: "originrouter-pricing-table" };
      }
    }
  }
  return { input: 0, output: 0, source: "free-seat" };
}

function declaredContext(alias, providerId, model) {
  const fromFile = Number(ceilings[`${alias}/${model}`]);
  if (Number.isFinite(fromFile) && fromFile > 0) return { tokens: fromFile, source: "owner-ceiling" };
  try {
    const entry = (getModelsByProviderId(providerId) || []).find((m) => m.id === model);
    const value = Number(entry?.contextWindow ?? entry?.caps?.contextWindow);
    if (Number.isFinite(value) && value > 0) return { tokens: value, source: "provider-declared" };
  } catch { /* no static list */ }
  return { tokens: CEILING_DEFAULT, source: "max-of-max-default" };
}

const today = new Date().toISOString().slice(0, 10);
const made = [];
const seenIds = new Set();

for (const seat of seats) {
  const alias = seat.slice(0, seat.indexOf("/"));
  const model = seat.slice(seat.indexOf("/") + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const caps = getCapabilitiesForModel(providerId, model) || {};
  const nodeLabel = nodeNames.get(providerId) || nodeNames.get(alias) || alias;
  const ctx = declaredContext(alias, providerId, model);
  const cost = lookupCost(alias, providerId, model);

  let id = `orsrc-${slug(alias)}-${slug(model)}`;
  if (seenIds.has(id)) id = `${id}-${seenIds.size}`;
  seenIds.add(id);

  const card = {
    id,
    provider: alias,
    model: seat,
    description: `OriginRouter ${COMBO} seat served through ${nodeLabel}. Capabilities measured nothing; skills are a deliberately uncertain prior, cost and context come from the gateway's own records.`,
    strengths: ["gateway-managed-seat", `provider:${alias}`],
    weaknesses: ["unmeasured"],
    skills: {
      coding: { theta: 5.0, se: 2.0 },
      debugging: { theta: 5.0, se: 2.0 },
      reasoning: { theta: Number.isFinite(caps.contextWindow) && caps.reasoning ? 5.5 : 5.0, se: 2.0 },
      math: { theta: 5.0, se: 2.0 },
      writing: { theta: 5.0, se: 2.0 },
      research: { theta: 5.0, se: 2.0 },
      review: { theta: 5.0, se: 2.0 },
      planning: { theta: 5.0, se: 2.0 },
      ui_frontend: { theta: 5.0, se: 2.0 },
      data_analysis: { theta: 5.0, se: 2.0 },
    },
    discrimination: 1.2,
    modalities: {
      input: caps.vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    features: {
      tools: true,
      json_mode: true,
      web: Boolean(caps.search),
    },
    limits: {
      context_tokens: Math.max(1, Math.round(ctx.tokens)),
      max_output_tokens: Math.max(1, Math.round(Number(caps.maxOutput) || 8192)),
    },
    cost: {
      input_per_mtok: Number(cost.input) || 0,
      output_per_mtok: Number(cost.output) || 0,
      currency: "USD",
    },
    latency: { ttft_ms_p50: 2500, tokens_per_sec: 40 },
    local: false,
    tags: ["harness:originrouter", `combo:${slug(COMBO)}`, `seat:${slug(alias)}`, "provenance:estimated"],
    card_version: today,
    provenance: "estimated",
    field_provenance: {
      cost: cost.source === "originrouter-pricing-table" ? "verified" : "estimated",
      limits: ctx.source === "provider-declared" ? "verified" : "estimated",
      skills: "estimated",
      latency: "estimated",
    },
    notes: `Generated by scripts/gen-panda-combo-cards.mjs for the "${COMBO}" combo. context_tokens source=${ctx.source}; cost source=${cost.source}. Replace theta/se with measured numbers once outcomes for this seat exist.`,
  };

  fs.writeFileSync(path.join(CARDS_DIR, `${id}.json`), `${JSON.stringify(card, null, 2)}\n`);
  made.push({ seat, id, context: card.limits.context_tokens, cost: `${card.cost.input_per_mtok}/${card.cost.output_per_mtok}` });
}

console.log(`combo "${COMBO}": ${seats.length} seats -> ${made.length} cards written into ${CARDS_DIR}`);
for (const m of made.slice(0, 12)) {
  console.log(`  ${m.seat.padEnd(42)} -> ${m.id} ctx=${m.context.toLocaleString("en-US")} cost=${m.cost}`);
}
console.log("  ...");
