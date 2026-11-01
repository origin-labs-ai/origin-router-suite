import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".or", "db", "data.sqlite");
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare("select key, value from kv where key like '%|llm'").all();
console.log("custom llm rows", rows.length);
const byProvider = new Map();
for (const r of rows) {
  const p = r.key.split("|")[0];
  byProvider.set(p, (byProvider.get(p) || 0) + 1);
}
console.log([...byProvider.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
console.log("sample:", rows[0]?.key, rows[0]?.value);
console.log("sample2:", rows[10]?.key, rows[10]?.value);
db.close();
