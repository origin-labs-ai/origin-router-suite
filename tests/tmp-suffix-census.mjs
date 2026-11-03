// Evidence for the naming rules, straight from the catalog:
//   1. which opaque ids (qmodel/qfmodel style) exist and what they really are;
//   2. how often each trailing token appears — that frequency table IS the list of
//      suffixes that must fold away, and the ones that must not (tier words).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { cleanModelLabel, modelGroupKey, prettyModelName } from "./_nameHarness.js";

const BASE = process.argv[2] || "http://127.0.0.1:20127";
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));
const { models } = await (await fetch(`${BASE}/api/models`, { headers: { Cookie: `auth_token=${token}` } })).json();

console.log("=== opaque / short ids that need an alias ===");
const opaque = (models || []).filter((m) => {
  const id = String(m.model || "");
  return /^(q|k|x)[a-z]?model[a-z0-9._-]*$/i.test(id)
    || /^(qmodel|qfmodel|kmodel|kfmodel)[\w.-]*$/i.test(id)
    || /^[a-z]{1,8}$/.test(id);
});
for (const m of opaque.slice(0, 40)) {
  console.log(`  ${(m.provider + "/" + m.model).padEnd(52)} name="${m.name || ""}" → "${prettyModelName(`${m.provider}/${m.model}`)}"`);
}
console.log(`  total short/opaque ids: ${opaque.length}`);

console.log("\n=== trailing-token frequency (what must fold) ===");
const counts = new Map();
for (const m of models || []) {
  const label = cleanModelLabel(`${m.provider}/${m.model}`);
  const tokens = label.split(/[-_/\s:]+/).filter(Boolean).map((t) => t.toLowerCase());
  if (tokens.length < 2) continue;
  // count every token after the first two: those are the qualifier tail
  for (const t of tokens.slice(2)) counts.set(t, (counts.get(t) || 0) + 1);
}
const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [token2, n] of ranked.slice(0, 70)) console.log(`  ${String(n).padStart(4)}  ${token2}`);

console.log("\n=== identities that keep a long tail (candidates for folding) ===");
const long = [...new Set((models || []).map((m) => modelGroupKey(`${m.provider}/${m.model}`)))]
  .filter((k) => k.split("-").length >= 4)
  .sort();
for (const k of long.slice(0, 45)) console.log(`  ${k}`);
console.log(`  total: ${long.length}`);
