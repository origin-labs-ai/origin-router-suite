// Does the LIVE server on 20128 still serve the deleted "cannot serve 1M" panel?
// Fetches the combos page as an authenticated browser would, finds the page
// chunk it references, downloads that chunk and searches it for the panel text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const BASE = process.argv[2] || "http://127.0.0.1:20128";
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));
const headers = { Cookie: `auth_token=${token}` };

const page = await fetch(`${BASE}/dashboard/combos`, { headers });
const html = await page.text();
const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9_()\-./%]+\.js/g)].map((m) => m[0]))];
const comboChunks = chunks.filter((c) => c.includes("combos"));
console.log("page status", page.status, "| referenced combos chunks:", comboChunks.length);

const NEEDLES = ["selected model", "raise the limit", "cannot serve"];
for (const chunk of comboChunks) {
  const res = await fetch(`${BASE}${chunk}`, { headers });
  const body = await res.text();
  const hits = NEEDLES.filter((n) => body.includes(n));
  console.log(`  ${res.status} ${chunk}  bytes=${body.length}  panelText=${hits.length ? hits.join(" | ") : "NONE"}`);
}

// The API the panel used to lean on, as served right now.
const models = await (await fetch(`${BASE}/api/models`, { headers })).json();
const flagged = (models.models || []).filter((m) => Number(m.caps?.contextWindow) > 0 && Number(m.caps?.contextWindow) < 1_048_576);
console.log(`\n/api/models rows=${models.models?.length} with a sub-1M declared window=${flagged.length}`);
for (const m of flagged.slice(0, 20)) {
  console.log(`  ${(m.provider + "/" + m.model).padEnd(44)} ctx=${String(m.caps.contextWindow).padEnd(9)} declared=${m.caps.contextDeclared} source=${m.caps.contextSource}`);
}
