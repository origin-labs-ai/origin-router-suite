import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".or", "db", "data.sqlite");
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare("select key, length(value) as n from kv order by n desc").all();
console.log("kv count", rows.length);
for (const r of rows.slice(0, 80)) console.log(r.n, r.key);
db.close();
