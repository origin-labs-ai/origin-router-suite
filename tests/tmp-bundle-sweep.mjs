// Sweep every JS file a page actually loads and look for deleted/blocked UI strings.
const BASE = process.argv[2] || "http://127.0.0.1:20127";
const PAGE = process.argv[3] || "/dashboard/combos";
const NEEDLES = ["selected model", "raise the limit", "cannot serve"];

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { SignJWT } = await import("jose");
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));
const headers = { Cookie: `auth_token=${token}` };

const html = await (await fetch(`${BASE}${PAGE}`, { headers })).text();
const srcs = [...new Set([...html.matchAll(/\/_next\/[^"']\*?\.js|\/_next\/static\/[^"'\\]+\.js|\/_next\/webpack[^"'\\]+/g)].map((m) => m[0]))];
const chunks = [...new Set([...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]))];
console.log(`${PAGE} -> ${chunks.length} script tags`);

let hits = 0;
for (const src of chunks) {
  const url = src.startsWith("http") ? src : `${BASE}${src}`;
  let body = "";
  try { body = await (await fetch(url, { headers })).text(); } catch { continue; }
  const found = NEEDLES.filter((n) => body.includes(n));
  if (found.length) { hits += 1; console.log(`  HIT ${url} :: ${found.join(" | ")}`); }
}
console.log(hits === 0 ? "CLEAN: no served bundle contains the deleted panel text" : `STALE: ${hits} bundle(s) still contain it`);
