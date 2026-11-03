// Why did only two seats answer? Group every upstream attempt from the last N minutes
// by seat and status, with the first error text seen, so "this model is idle" is
// answered with either "the router never chose it" or "it was chosen and refused".
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { modelTier } from "../src/shared/utils/modelTier.js";

const BASE = process.argv[3] || "http://127.0.0.1:20127";

// The provider's own name for each seat: tier classification is wrong without it
// (`qoder/qfmodel` is named "Qwen3.8-Flash", so it is a flash model, not a Pro one).
async function seatNames() {
  try {
    const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
    const token = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m")
      .sign(new TextEncoder().encode(secret));
    const res = await fetch(`${BASE}/api/models`, { headers: { Cookie: `auth_token=${token}` } });
    const { models } = await res.json();
    const map = new Map();
    for (const m of models || []) map.set(`${m.provider}/${m.model}`, m.name || "");
    return map;
  } catch {
    return new Map();
  }
}
const NAMES = await seatNames();

const MINUTES = Number(process.argv[2] || 10);
// requestDetails.status stores a word ("success", "error"), not an HTTP code.
const isOk = (status) => /^2\d\d$/.test(String(status)) || String(status).toLowerCase().startsWith("success");
const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const since = new Date(Date.now() - MINUTES * 60 * 1000).toISOString().slice(0, 19);
const rows = db.prepare(
  "select provider, model, status, timestamp, data from requestDetails where timestamp >= ? order by id",
).all(since);
db.close();

const bySeat = new Map();
for (const row of rows) {
  const seat = `${row.provider}/${row.model}`;
  if (/jev/i.test(String(row.model))) continue; // the router model's own calls
  let entry = bySeat.get(seat);
  if (!entry) {
    const seatName = NAMES.get(seat) || "";
    entry = { seat, statuses: new Map(), sample: "", tier: modelTier(seat, seatName).subcategory };
    bySeat.set(seat, entry);
  }
  const status = String(row.status);
  entry.statuses.set(status, (entry.statuses.get(status) || 0) + 1);
  if (!entry.sample && !isOk(status)) {
    // The stored detail keeps the upstream message in whichever shape the failing
    // layer produced it (translated error, raw body, or a bare string).
    try {
      const data = JSON.parse(row.data || "{}");
      // The stored detail nests the upstream reply: data.response holds the parsed
      // provider error (message/status), data.request the outbound body.
      const resp = data?.response ?? data?.providerResponse ?? {};
      const candidates = [
        data?.error?.message, data?.error, data?.message,
        resp?.error?.message, resp?.error, resp?.message, resp?.detail, resp?.statusText,
        typeof resp === "string" ? resp : null,
        data?.responseBody, data?.responseBodyText, data?.body, data?.detail,
      ];
      let text = candidates.find((c) => typeof c === "string" && c.trim()) || "";
      if (!text) {
        const obj = candidates.find((c) => c && typeof c === "object");
        text = obj ? JSON.stringify(obj).slice(0, 180) : `statusField:${String(row.status)}`;
      }
      entry.sample = String(text).replace(/\s+/g, " ").slice(0, 180);
    } catch { entry.sample = "(unparsed)"; }
  }
}

const list = [...bySeat.values()].sort((a, b) => {
  const aOk = [...a.statuses.entries()].filter(([s]) => isOk(s)).length;
  const bOk = [...b.statuses.entries()].filter(([s]) => isOk(s)).length;
  return bOk - aOk;
});

console.log(`attempts in the last ${MINUTES}min across ${list.length} seats\n`);
for (const entry of list) {
  const statuses = [...entry.statuses.entries()].map(([s, n]) => `${s}×${n}`).join(" ");
  console.log(`  ${entry.seat.padEnd(56)} ${entry.tier.padEnd(24)} ${statuses}`);
  if (entry.sample) console.log(`      ↳ ${entry.sample}`);
}
const healthy = list.filter((e) => [...e.statuses.keys()].some((s) => isOk(s)));
console.log(`\nseats that answered at least once: ${healthy.length}/${list.length}`);

// Why the rest sit idle: group the refusal reasons by how many attempts produced them.
const reasons = new Map();
for (const entry of list) {
  if (!entry.sample) continue;
  const failing = [...entry.statuses.entries()].filter(([s]) => !isOk(s)).reduce((n, [, c]) => n + c, 0);
  reasons.set(entry.sample, (reasons.get(entry.sample) || 0) + failing);
}
console.log("\n=== refusal reasons (attempts) ===");
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}
