// Tier check: does the classification hold for EVERY model in the catalog, and for
// the exact seats in the owner's combo? Prints the counts, the subcategory list, and
// every seat that lands in a bucket the rules cannot justify (those are the manual
// fixes). Names come from the same /api/models rows the dashboard sees.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { modelTier } from "../src/shared/utils/modelTier.js";
import { modelGroupKey, prettyModelName } from "../src/shared/utils/modelDisplayName.js";

const BASE = process.argv[2] || "http://127.0.0.1:20127";
const COMBO = process.env.OR_COMBO || "claude-opus-5-5";
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));

const { models } = await (await fetch(`${BASE}/api/models`, { headers: { Cookie: `auth_token=${token}` } })).json();
const nameOf = new Map();
for (const m of models || []) {
  const seat = `${m.provider}/${m.model}`;
  if (m.name) nameOf.set(seat, m.name);
  // also let a bare id resolve (nested seats are written alias/model, but ids repeat)
  if (m.name && !nameOf.has(m.model)) nameOf.set(m.model, m.name);
}

const tiers = { pro: 0, flash: 0 };
const subcategories = new Map();
const labelByIdentity = new Map();
for (const m of models || []) {
  const seat = `${m.provider}/${m.model}`;
  const name = nameOf.get(seat) || "";
  const info = modelTier(seat, name);
  tiers[info.tier] += 1;
  const identity = modelGroupKey(name || seat);
  if (!labelByIdentity.has(identity)) labelByIdentity.set(identity, info);
  subcategories.set(info.subcategory, (subcategories.get(info.subcategory) || 0) + 1);
}

console.log(`catalog rows=${models.length}`);
console.log(`tiers: pro=${tiers.pro} flash=${tiers.flash}`);
console.log(`distinct categories by identity: ${labelByIdentity.size}`);
console.log("\n=== subcategories (top 40) ===");
for (const [name, count] of [...subcategories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  console.log(`  ${String(count).padStart(4)}  ${name}`);
}

console.log("\n=== suspicious classifications in the catalog ===");
const suspicious = [];
for (const [identity, info] of labelByIdentity) {
  if (!info.family || /unnamed|^.$/.test(info.family)) suspicious.push(["no family", identity, info]);
  else if (info.tier === "pro" && /\d+b$/.test(identity)) suspicious.push(["small model called pro", identity, info]);
  else if (/(free|latest|preview)$/.test(identity)) suspicious.push(["noise left", identity, info]);
}
for (const [why, identity, info] of suspicious.slice(0, 40)) {
  console.log(`  ${why.padEnd(22)} ${identity.padEnd(38)} → "${info.label}" (${info.subcategory})`);
}
console.log(`  total suspicious: ${suspicious.length}`);

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const seats = JSON.parse(db.prepare("select models from combos where name=?").get(COMBO).models);
db.close();

console.log(`\n=== combo "${COMBO}" seats: ${seats.length} ===`);
const comboTiers = new Map();
for (const seat of seats) {
  const name = nameOf.get(seat) || nameOf.get(seat.split("/").slice(1).join("/")) || "";
  const info = modelTier(seat, name);
  comboTiers.set(info.subcategory, (comboTiers.get(info.subcategory) || 0) + 1);
  console.log(`  ${seat.padEnd(52)} name="${name || "-"}" → "${info.label}" | ${info.category} | ${info.subcategory}`);
}
console.log("\n=== combo pools ===");
for (const [name, count] of [...comboTiers.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${name}`);
}
