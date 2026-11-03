// Router proof run: one script that answers, with numbers, the questions the owner
// asked — how does fallback actually work, which brain decided, did any explicit
// model get re-routed, and do eight concurrent sessions keep answering without
// anything stalling.
//
// Evidence sources (no log squinting):
//   GET  /api/panda/status  → decisions: pandaDecisions / jevDecisions / blends /
//                             fairnessPromotions / tierSteered / distinctSeatsChosen
//   ~/.or/db/data.sqlite     → usageHistory: which seat answered which request
//   ~/.or/panda/router_log   → Panda's own trace rows
//
// Usage: node tests/tmp-router-proof.mjs [baseUrl] [agents] [turns]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";

const BASE = process.argv[2] || "http://127.0.0.1:20127";
const AGENTS = Number(process.argv[3] || 8);
const TURNS = Number(process.argv[4] || 4);
const COMBO = process.env.OR_COMBO || "claude-opus-5-5";
const GATEWAY_DB = path.join(os.homedir(), ".or", "db", "data.sqlite");
const PANDA_DB = path.join(os.homedir(), ".or", "panda", "router_log.sqlite");

const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30m")
  .sign(new TextEncoder().encode(secret));
const dash = { headers: { Cookie: `auth_token=${token}`, "Content-Type": "application/json" } };

function activeKey() {
  const db = new DatabaseSync(GATEWAY_DB, { readOnly: true });
  try {
    const row = db.prepare("select key from apiKeys where isActive = 1 order by createdAt limit 1").get();
    if (!row?.key) throw new Error("no active api key");
    return row.key;
  } finally { db.close(); }
}
const KEY = activeKey();

function comboSeats() {
  const db = new DatabaseSync(GATEWAY_DB, { readOnly: true });
  try {
    const row = db.prepare("select models, maxContextWindow from combos where name = ?").get(COMBO);
    const models = JSON.parse(row?.models || "[]").filter((s) => typeof s === "string" && s.includes("/"));
    return { models, ceiling: Number(row?.maxContextWindow) || null };
  } finally { db.close(); }
}

function comboStrategy() {
  const db = new DatabaseSync(GATEWAY_DB, { readOnly: true });
  try {
    const row = db.prepare("select data from settings where id = 1").get();
    const settings = JSON.parse(row?.data || "{}");
    return {
      global: settings.comboStrategy || null,
      perCombo: (settings.comboStrategies || {})[COMBO] || null,
      sticky: settings.comboStickyRoundRobinLimit ?? null,
      policy: settings.routingPolicy || null,
    };
  } finally { db.close(); }
}

async function status() {
  const res = await fetch(`${BASE}/api/panda/status?refresh=1`, dash);
  return await res.json();
}

function usageCursor() {
  const db = new DatabaseSync(GATEWAY_DB, { readOnly: true });
  try { return db.prepare("select coalesce(max(id),0) as n from usageHistory").get().n; }
  finally { db.close(); }
}

function usageSince(id) {
  const db = new DatabaseSync(GATEWAY_DB, { readOnly: true });
  try {
    return db.prepare("select id, provider, model, connectionId, status, timestamp from usageHistory where id > ? order by id").all(id);
  } finally { db.close(); }
}

// Attempt-level evidence: usageHistory only records the seat that ANSWERED, so a
// brain pick that failed and rotated away is invisible there. requestDetails keeps
// every attempt with its status, which is what shows the real fan-out.
// Queried by timestamp, not by row id: a streaming row is rewritten when the
// response completes, which moves its id and would double-count the window.
function attemptsSince(sinceEpochMs) {
  const db = new DatabaseSync(GATEWAY_DB, { readOnly: true });
  try {
    return db.prepare("select id, provider, model, connectionId, status from requestDetails where timestamp >= ? order by id")
      .all(new Date(sinceEpochMs).toISOString().slice(0, 19));
  } finally { db.close(); }
}

const claudeBody = (model, text) => ({
  model,
  max_tokens: 24,
  stream: true,
  system: [{ type: "text", text: "You are a concise assistant. Answer in one word." }],
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [{
    name: "read_file",
    description: "Read a file from disk",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }],
});

async function ask({ model, sessionId, text, endpoint = "/v1/messages", body }) {
  const started = Date.now();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KEY}`,
    ...(sessionId ? { "x-session-id": sessionId } : {}),
  };
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST", headers, body: JSON.stringify(body || claudeBody(model, text || "Reply with exactly: ok")),
  });
  const text2 = await res.text();
  return {
    status: res.status,
    ms: Date.now() - started,
    errorFrame: /"type"\s*:\s*"error"/.test(text2) || /"error"\s*:\s*\{/.test(text2),
    streamed: text2.includes("message_start") || text2.includes("data:"),
    bytes: text2.length,
  };
}

async function setPolicy(updates) {
  const current = await (await fetch(`${BASE}/api/settings`, dash)).json();
  const res = await fetch(`${BASE}/api/settings`, {
    ...dash,
    method: "PATCH",
    body: JSON.stringify({ routingPolicy: { ...(current.routingPolicy || {}), ...updates } }),
  });
  if (!res.ok) throw new Error(`PATCH settings failed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).routingPolicy;
}

const out = [];
const say = (...args) => { out.push(args.join(" ")); console.log(...args); };

// ─────────────────────────────────────────────────────────────────────────────
say("=== 0. setup ===");
const seats = comboSeats();
const strategy = comboStrategy();
const s0 = await status();
say(JSON.stringify({
  base: BASE,
  combo: COMBO,
  seats: seats.models.length,
  ceiling: seats.ceiling,
  globalStrategy: strategy.global,
  perComboStrategy: strategy.perCombo?.fallbackStrategy || null,
  smartPolicy: strategy.perCombo?.smartPolicy || null,
  routerModel: strategy.perCombo?.routerModel || "auto (oc/jev-1.13-free)",
  stickyRoundRobin: strategy.sticky,
  brain: s0.brain,
  pandaReady: s0.panda,
  jevReady: s0.jev,
  cards: s0.detail?.cards,
}, null, 2));

// ─────────────────────────────────────────────────────────────────────────────
const SKIP_MODES = process.env.OR_SKIP_MODES === "1";
if (!SKIP_MODES) {
say("\n=== 1. mode-by-mode: who is consulted, who decides ===");
const modes = {};
for (const mode of ["panda", "jev", "merged"]) {
  await setPolicy({ routerBrain: mode });
  const before = await status();
  const usage0 = usageCursor();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    // A distinct session per request: every turn then really asks the brain again,
    // instead of being answered from the sticky prompt-cache seat.
    const r = await ask({ model: COMBO, sessionId: `mode-${mode}-${i}-${Date.now()}`, text: `mode probe ${mode} ${i} ${Date.now()}` });
    runs.push(r);
  }
  const after = await status();
  const rows = usageSince(usage0);
  modes[mode] = {
    panda: after.decisions.pandaDecisions - before.decisions.pandaDecisions,
    jev: after.decisions.jevDecisions - before.decisions.jevDecisions,
    blends: after.decisions.blends - before.decisions.blends,
    statuses: runs.map((r) => r.status),
    errorFrames: runs.filter((r) => r.errorFrame).length,
    answeredBy: [...new Set(rows.map((r) => `${r.provider}/${r.model}`))],
  };
  say(`  ${mode}: ${JSON.stringify(modes[mode])}`);
}
const rules = {
  "panda mode asks Panda only": modes.panda.panda > 0 && modes.panda.jev === 0,
  "jev mode asks Jev only": modes.jev.jev > 0 && modes.jev.panda === 0,
  "merged mode asks both": modes.merged.panda > 0 && modes.merged.jev > 0,
  "no mode leaked an error frame": Object.values(modes).every((m) => m.errorFrames === 0),
  "every mode answered 200": Object.values(modes).every((m) => m.statuses.every((s) => s === 200)),
};
for (const [name, ok] of Object.entries(rules)) say(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
say("\n=== 2. an explicitly named model is never re-routed (merged = worst case) ===");
await setPolicy({ routerBrain: "merged", seatFairness: 0.3 });
if (!SKIP_MODES) {
const probeSeat = seats.models[0];
const probes = [
  { name: "raw seat on /v1/chat/completions", endpoint: "/v1/chat/completions", body: { model: probeSeat, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 16 } },
  { name: "same seat on /v1/messages", endpoint: "/v1/messages", body: claudeBody(probeSeat, `explicit probe ${Date.now()}`) },
];
const hijack = [];
for (const probe of probes) {
  const before = await status();
  const usage0 = usageCursor();
  const r = await ask({ endpoint: probe.endpoint, body: probe.body, sessionId: `explicit-${Date.now()}` });
  const after = await status();
  const rows = usageSince(usage0);
  const delta = {
    panda: after.decisions.pandaDecisions - before.decisions.pandaDecisions,
    jev: after.decisions.jevDecisions - before.decisions.jevDecisions,
  };
  hijack.push({ ...probe.name, requested: probeSeat, status: r.status, errorFrame: r.errorFrame, ...delta, served: rows.map((x) => `${x.provider}/${x.model}`) });
  say(`  ${probe.name}: status=${r.status} brainFires=${JSON.stringify(delta)} served=[${rows.map((x) => `${x.provider}/${x.model}`).join(", ")}] → ${delta.panda === 0 && delta.jev === 0 ? "PASS (no brain consulted)" : "CHECK"}`);
}
}

// ─────────────────────────────────────────────────────────────────────────────
say(`\n=== 3. ${AGENTS} concurrent agent sessions, ${TURNS} turns each, continuous ===`);
const before = await status();
const usage0 = usageCursor();
const attempts0 = Date.now() - 15000;
const wallStart = Date.now();
const agents = await Promise.all(Array.from({ length: AGENTS }, async (_, i) => {
  const session = `agent-${i}-${Date.now()}`;
  const turns = [];
  for (let t = 0; t < TURNS; t++) {
    // Continuous: the next turn starts only after this one answered.
    turns.push(await ask({ model: COMBO, sessionId: session, text: `agent ${i} turn ${t} ${Date.now()}` }));
  }
  return { session, turns };
}));
const wallMs = Date.now() - wallStart;
const flat = agents.flatMap((a) => a.turns);
const after = await status();
const rows = usageSince(usage0);
const attemptRows = attemptsSince(attempts0);
const seatHits = new Map();
for (const row of rows) {
  const seat = `${row.provider}/${row.model}`;
  seatHits.set(seat, (seatHits.get(seat) || 0) + 1);
}
const connections = new Set(rows.map((r) => r.connectionId).filter(Boolean));
const attempted = new Map();
for (const row of attemptRows) {
  const seat = `${row.provider}/${row.model}`;
  attempted.set(seat, (attempted.get(seat) || 0) + 1);
}
// requestDetails.status holds a word ("success"/"error"), not an HTTP code.
const attemptOk = (status) => /^2\d\d$/.test(String(status)) || String(status).toLowerCase().startsWith("success");
const okAttempts = attemptRows.filter((r) => attemptOk(r.status)).length;
const report = {
  requests: flat.length,
  wallMs,
  statuses: flat.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
  errorFrames: flat.filter((r) => r.errorFrame).length,
  allStreamed: flat.every((r) => r.streamed),
  slowestMs: Math.max(...flat.map((r) => r.ms)),
  medianMs: flat.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(flat.length / 2)],
  pandaDecisions: after.decisions.pandaDecisions - before.decisions.pandaDecisions,
  jevDecisions: after.decisions.jevDecisions - before.decisions.jevDecisions,
  fairnessPromotions: after.decisions.fairnessPromotions - before.decisions.fairnessPromotions,
  tierSteered: after.decisions.tierSteered - before.decisions.tierSteered,
  distinctSeatsServed: seatHits.size,
  distinctSeatsAttempted: attempted.size,
  upstreamAttempts: attemptRows.length,
  upstreamAttemptsOk: okAttempts,
  distinctConnectionsTouched: new Set(attemptRows.map((r) => r.connectionId).filter(Boolean)).size,
  distinctConnectionsUsed: connections.size,
  comboSeats: seats.models.length,
};
say(JSON.stringify(report, null, 2));
say("  seats that were tried (attempts): count");
for (const [seat, count] of [...attempted.entries()].sort((a, b) => b[1] - a[1])) {
  say(`   ${String(count).padStart(3)}  ${seat}`);
}
say("  seats that answered: count");
for (const [seat, count] of [...seatHits.entries()].sort((a, b) => b[1] - a[1])) {
  say(`   ${String(count).padStart(3)}  ${seat}`);
}
const never = seats.models.filter((seat) => ![...attempted.keys()].some((served) => served === seat || served.endsWith(`/${seat.slice(seat.indexOf("/") + 1)}`)));
say(`  seats never even tried this run: ${never.length}/${seats.models.length}`);
const unanswered = seats.models.filter((seat) => ![...seatHits.keys()].some((served) => served === seat || served.endsWith(`/${seat.slice(seat.indexOf("/") + 1)}`)));
say(`  tried but never answered (quota/auth dead): ${unanswered.length}/${seats.models.length}`);
say(`  brain tally since boot: ${JSON.stringify(after.decisions.byMode)} panda=${after.decisions.pandaDecisions} jev=${after.decisions.jevDecisions} blends=${after.decisions.blends}`);
if (flat.some((r) => r.status !== 200 || r.errorFrame)) {
  say("  FAILURES: " + JSON.stringify(flat.filter((r) => r.status !== 200 || r.errorFrame), null, 2));
}
