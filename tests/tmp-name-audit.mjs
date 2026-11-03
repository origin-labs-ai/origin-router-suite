// Name audit: what do the 2700+ model ids actually look like, and what does the
// current pretty-name logic turn them into? Evidence for the picker rewrite:
// which ids carry "@", ":", "~", UUIDs; which collide; which read as junk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const BASE = process.argv[2] || "http://127.0.0.1:20127";
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));

const { models } = await (await fetch(`${BASE}/api/models`, { headers: { Cookie: `auth_token=${token}` } })).json();
const { prettyModelName, cleanModelLabel, modelCategoryName, modelIdentity, modelGroupKey, modelMatchesQuery, groupDisplayName } = await import("./_nameHarness.js");

const ids = (models || []).map((m) => `${m.provider}/${m.model}`);
const uniq = [...new Set(ids)];
console.log(`rows=${models.length} distinct=${uniq.length}`);

const buckets = {
  withAt: uniq.filter((s) => s.includes("@")),
  withColon: uniq.filter((s) => s.includes(":")),
  withTilde: uniq.filter((s) => s.includes("~")),
  withUuid: uniq.filter((s) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(s)),
  withDot: uniq.filter((s) => /\d\.\d/.test(s)),
  upperInside: uniq.filter((s) => /[a-z][A-Z]/.test(s.split("/").slice(1).join("/"))),
};
console.log("\n=== how many ids carry what ===");
for (const [k, list] of Object.entries(buckets)) console.log(`  ${k.padEnd(11)} ${list.length}`);

// The same model under several spellings is exactly what buries it in the picker.
const byCategory = new Map();
for (const id of uniq) {
  const key = modelGroupKey(id);
  if (!byCategory.has(key)) byCategory.set(key, []);
  byCategory.get(key).push(id);
}
const multi = [...byCategory.entries()].filter(([, list]) => list.length > 1).sort((a, b) => b[1].length - a[1].length);
console.log(`\n=== distinct models: ${byCategory.size}; groups with several spellings: ${multi.length} (top 10) ===`);
for (const [key, list] of multi.slice(0, 10)) {
  console.log(`  ${key}  (${list.length} spellings) → "${groupDisplayName(list)}"`);
  for (const id of list.slice(0, 5)) console.log(`      ${id}  →  "${prettyModelName(id)}"`);
}

// Search-failure check: his exact complaint was not finding MiniMax M3.1 Flash.
for (const needle of ["minimax m3.1 flash", "minimaxm31flash", "glm 5.3", "sol pro", "qwen 3.8 flash"]) {
  const hits = uniq.filter((s) => modelMatchesQuery(s, needle));
  console.log(`\n=== search "${needle}" → ${hits.length} ids ===`);
  for (const id of hits.slice(0, 8)) console.log(`  ${id.padEnd(62)} → "${prettyModelName(id)}"  cat="${modelCategoryName(id)}"`);
}

for (const needle of ["minimax", "anyrouter", "glm-5.3", "sol", "qwen-3.8"]) {
  const hits = uniq.filter((s) => s.toLowerCase().includes(needle));
  console.log(`\n=== ids containing "${needle}": ${hits.length} ===`);
  for (const id of hits.slice(0, 10)) console.log(`  ${id.padEnd(62)} → "${prettyModelName(id)}"  cat="${modelCategoryName(id)}"  id="${modelIdentity(id)}"`);
}

// Labels that came out wrong: empty, unchanged, still carrying noise, or starting
// with a version number (the sign that the model's own first word was eaten).
const suspicious = uniq.filter((id) => {
  const label = prettyModelName(id);
  return label === id
    || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(label)
    || label.includes("@")
    || label.includes("/")
    || /^\d|^v\d/i.test(label)
    || /ollama|local|chat|compatible|provider|engine/i.test(label)
    || label.length > 46;
});
console.log(`\n=== suspicious labels: ${suspicious.length} (first 40) ===`);
for (const id of suspicious.slice(0, 40)) console.log(`  ${id.padEnd(64)} → "${prettyModelName(id)}"`);
