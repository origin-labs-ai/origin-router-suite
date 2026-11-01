import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const rows = db.prepare("select key, value from kv where key like '%|llm'").all();
let at = 0, zai = 0;
for (const row of rows) {
  const key = row.key;
  const value = String(row.value || "");
  if (key.includes("@") || value.includes("@")) {
    if (at < 25) console.log("AT", key, value.slice(0, 180));
    at++;
  }
  if (/z\.?ai/i.test(key) || /z\.?ai/i.test(value)) {
    if (zai < 25) console.log("ZAI", key, value.slice(0, 180));
    zai++;
  }
}
console.log({ total: rows.length, at, zai });

const nodes = db.prepare("select id, name, type, providerId from providerNodes").all();
for (const n of nodes) console.log("NODE", n);
db.close();
