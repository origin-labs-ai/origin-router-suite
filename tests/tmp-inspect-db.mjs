import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".or", "db", "data.sqlite");
const db = new DatabaseSync(file, { readOnly: true });
const tables = db.prepare("select name from sqlite_master where type='table' order by name").all();
console.log("tables:", tables.map((t) => t.name).join(", "));
for (const t of tables) {
  const c = db.prepare(`select count(*) as n from "${t.name}"`).get();
  console.log(t.name, c.n);
}
try {
  const rows = db.prepare("select * from providerConnections").all();
  console.log("connections", rows.length);
  for (const r of rows.slice(0, 60)) {
    console.log(JSON.stringify({ id: r.id, provider: r.provider, name: r.name, active: r.isActive, data: r.providerSpecificData }));
  }
} catch (e) {
  console.log("conn err", e.message);
}
db.close();
