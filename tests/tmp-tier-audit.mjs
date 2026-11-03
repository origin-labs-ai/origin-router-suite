// Dump every distinct model identity in the catalog so the tier rules can be
// written against reality instead of guessed, and so every model that the rules
// cannot classify is visible (that list is the manual fix-up work).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { modelGroupKey, prettyModelName, cleanModelLabel } from "./_nameHarness.js";

const BASE = process.argv[2] || "http://127.0.0.1:20127";
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));

const { models } = await (await fetch(`${BASE}/api/models`, { headers: { Cookie: `auth_token=${token}` } })).json();

// seat strings exactly as a combo stores them, plus the identity they collapse to.
const byIdentity = new Map();
for (const m of models || []) {
  const seat = `${m.provider}/${m.model}`;
  const key = modelGroupKey(seat);
  if (!key) continue;
  if (!byIdentity.has(key)) byIdentity.set(key, { key, seats: [], labels: new Set(), providers: new Set() });
  const entry = byIdentity.get(key);
  entry.seats.push(seat);
  entry.labels.add(prettyModelName(seat));
  entry.providers.add(m.provider);
}

const identities = [...byIdentity.values()].sort((a, b) => a.key.localeCompare(b.key));
console.log(`distinct identities: ${identities.size || identities.length}`);

const WORDS = {
  pro: /\bpro\b|sol|opus|fable|ultra|max|advanced|k3|gpt-6|thinking/,
  flash: /flash|lite|mini|nano|small|air|turbo|free|tiny|express|economics/,
  deepseek: /deepseek|^v4/,
};
const buckets = { pro: [], deepseekFlash: [], flash: [], unknown: [] };
for (const entry of identities) {
  const k = entry.key.toLowerCase();
  const isDeepSeek = WORDS.deepseek.test(k);
  if (WORDS.flash.test(k)) {
    if (isDeepSeek) buckets.deepseekFlash.push(entry);
    else buckets.flash.push(entry);
  } else if (WORDS.pro.test(k)) {
    buckets.pro.push(entry);
  } else {
    buckets.unknown.push(entry);
  }
}

for (const [name, list] of Object.entries(buckets)) {
  console.log(`\n### ${name}: ${list.length}`);
  for (const entry of list) {
    console.log(`  ${entry.key.padEnd(46)} ×${String(entry.seats.length).padStart(2)} providers=${entry.providers.size}  "${[...entry.labels][0]}"`);
  }
}
