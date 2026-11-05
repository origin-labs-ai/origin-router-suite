// Snapshot current PROVIDERS output to JSON (run on OLD code before refactor).
// Usage: node tests/__baseline__/snapshot-providers.mjs
//
// OAuth client secrets are stripped on the way out. The baseline is a public,
// committed artifact whose job is to catch config drift, and `clientSecret` is
// not part of that comparison: verify-providers.mjs drops it (ADDED_FIELDS) from
// both sides, so keeping the literal buys nothing and costs a credential in the
// repository - which is also what GitHub's push protection refused to accept.
// Everything that ships the real value (the registry source) stays untouched.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const SECRET_KEY = /secret/i;

function withoutSecrets(node) {
  if (Array.isArray(node)) return node.map(withoutSecrets);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = SECRET_KEY.test(key) && typeof value === "string" ? "REDACTED" : withoutSecrets(value);
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "providers-baseline.json");
const redacted = withoutSecrets(JSON.parse(JSON.stringify(PROVIDERS)));
writeFileSync(out, JSON.stringify(redacted, null, 2));
const count = JSON.stringify(redacted).match(/REDACTED/g)?.length || 0;
console.log(`Snapshot ${Object.keys(PROVIDERS).length} providers (${count} credential fields redacted) → ${out}`);
