// Replays exactly what the combo editor now does, using the dashboard API the
// browser calls: fetch /api/models with a minted session token, build the same
// maps as useModelCaps, then check the flagged seats and recompute the "cannot
// serve 1M" violation list for the user's combo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";

const BASE = "http://127.0.0.1:20128";
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));

const res = await fetch(`${BASE}/api/models`, { headers: { Cookie: `auth_token=${token}` } });
if (!res.ok) {
  console.log("api/models status", res.status, (await res.text()).slice(0, 160));
  process.exit(1);
}
const { models } = await res.json();

// Same maps as src/shared/hooks/useModelCaps.js buildMaps()
const byFull = new Map();
const byId = new Map();
for (const m of models || []) {
  if (!m.caps) continue;
  if (m.fullModel) byFull.set(m.fullModel, m.caps);
  if (m.routedModel) byFull.set(m.routedModel, m.caps);
  if (m.model) byId.set(m.model, m.caps);
}
const capsFor = (seat) => {
  if (byFull.has(seat)) return byFull.get(seat);
  const bare = seat.includes("/") ? seat.slice(seat.indexOf("/") + 1) : seat;
  return byId.get(bare) || null;
};

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const seats = JSON.parse(db.prepare("select models from combos where name=?").get("claude-opus-5-5").models);
const customRows = db.prepare("select key, value from kv where key like '%|llm'").all();
db.close();

const NEEDLES = ["atria", "hy4", "fugu", "qfmodel", "deepseek-chat", "deepseek-pro", "deepseek-flash", "v4.1-flash", "omni"];
console.log("=== flagged models as the dashboard now sees them ===");
for (const m of models || []) {
  const hay = `${m.provider}/${m.model} ${m.name || ""}`.toLowerCase();
  if (!NEEDLES.some((n) => hay.includes(n))) continue;
  console.log(`  ${(m.provider + "/" + m.model).padEnd(46)} name=${String(m.name || "").padEnd(26)} ctx=${String(m.caps?.contextWindow).padEnd(10)} declared=${m.caps?.contextDeclared}`);
}

console.log("\n=== custom rows: does caps.contextWindow exist now? ===");
let withCaps = 0, total = 0;
for (const row of customRows) {
  let parsed; try { parsed = JSON.parse(row.value); } catch { continue; }
  for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!e?.id) continue;
    total += 1;
    if (Number.isFinite(Number(e.caps?.contextWindow))) withCaps += 1;
  }
}
console.log(`  custom models ${total}, with a declared caps.contextWindow: ${withCaps}`);

// The editor's check, replayed for every combo the way the UI now does it.
const LIMIT = 1_048_576;
const db2 = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const allCombos = db2.prepare("select name, models, maxContextWindow from combos").all();
db2.close();

let grandTotal = 0;
for (const c of allCombos) {
  let seats2 = [];
  try { seats2 = JSON.parse(c.models || "[]"); } catch { continue; }
  const limit = Number(c.maxContextWindow) || LIMIT;
  const violations = seats2
    .filter((s) => typeof s === "string" && s.includes("/"))
    .map((seat) => ({ seat, window: capsFor(seat)?.contextWindow ?? null }))
    .filter(({ window }) => Number.isFinite(window) && window < limit);
  grandTotal += violations.length;
  console.log(`combo ${c.name} (limit ${limit.toLocaleString("en-US")}): seats ${seats2.length}, violations ${violations.length}`);
  for (const v of violations.slice(0, 12)) console.log(`   ! ${v.seat} → ${v.window}`);
}
console.log(`\nTOTAL violations across ${allCombos.length} combos: ${grandTotal}`);

console.log("\n=== the four that kept showing ===");
for (const m of models || []) {
  const full = `${m.provider}/${m.model}`;
  if (!/(~deepseek\/deepseek-(flash|pro)-latest|deepseek\/deepseek-chat|qwen3\.8-omni-flash)$/.test(full)) continue;
  console.log(`  ${full.padEnd(46)} ctx=${String(m.caps?.contextWindow).padEnd(10)} declared=${m.caps?.contextDeclared} source=${m.caps?.contextSource}`);
}
