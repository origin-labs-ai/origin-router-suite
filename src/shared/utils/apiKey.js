import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const KEY_ID_LENGTH = 16;
const SECRET_FILE = path.join(DATA_DIR, "api-key-secret");

/**
 * HMAC secret for the API-key integrity digest. Order of preference:
 * 1. API_KEY_SECRET env var
 * 2. per-install secret persisted at DATA_DIR/api-key-secret (0600)
 * 3. per-process random when the data dir is not writable
 *
 * Auth is an exact match against the apiKeys table, so the digest is
 * integrity-only: minting with the new secret does not invalidate existing keys.
 * The old build shipped a constant fallback secret that made the digest forgeable
 * offline.
 */
function loadSecret() {
  if (process.env.API_KEY_SECRET) return process.env.API_KEY_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, "utf8").trim();
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(SECRET_FILE, 0o600);
    } catch {
      // Windows ignores mode on write; chmod after is best effort
    }
    return secret;
  } catch (e) {
    console.warn(
      `[apiKey] could not persist HMAC secret to ${SECRET_FILE} (${e?.message || e}); using a per-process random secret instead`
    );
    return crypto.randomBytes(32).toString("hex");
  }
}

let cachedSecret;
function secret() {
  if (cachedSecret === undefined) cachedSecret = loadSecret();
  return cachedSecret;
}

// 16 lowercase-alnum chars via crypto.randomInt (crypto-secure, not Math.random)
function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < KEY_ID_LENGTH; i++) {
    result += chars[crypto.randomInt(chars.length)];
  }
  return result;
}

function generateCrc(machineId, keyId) {
  return crypto.createHmac("sha256", secret()).update(machineId + keyId).digest("hex").slice(0, 8);
}

export function generateApiKeyWithMachine(machineId) {
  const keyId = generateKeyId();
  const crc = generateCrc(machineId, keyId);
  const key = `sk-${machineId}-${keyId}-${crc}`;
  return { key, keyId };
}

export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;
  const parts = apiKey.split("-");
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;
    if (crc !== generateCrc(machineId, keyId)) return null;
    return { machineId, keyId, isNewFormat: true };
  }
  if (parts.length === 2) {
    return { machineId: null, keyId: parts[1], isNewFormat: false };
  }
  return null;
}

export function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  if (!parsed.isNewFormat) return true;
  return true;
}

export function isNewFormatKey(apiKey) {
  const parsed = parseApiKey(apiKey);
  return parsed?.isNewFormat === true;
}
