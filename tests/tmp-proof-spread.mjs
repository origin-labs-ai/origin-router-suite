// Proof that the orchestrator was actually consulted and that the fleet spread:
//   - Panda's own SQLite route/outcome log (only written when the router called it)
//   - distinct seats + connections in the gateway's request detail table
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const panda = new DatabaseSync(path.join(os.homedir(), ".or", "panda", "router_log.sqlite"), { readOnly: true });
const pTables = panda.prepare("select name from sqlite_master where type='table'").all().map((t) => t.name);
for (const name of pTables) {
  console.log(`panda ${name}: ${panda.prepare(`select count(*) as n from "${name}"`).get().n} rows`);
}
panda.close();

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const tables = db.prepare("select name from sqlite_master where type='table'").all().map((x) => x.name);
const tbl = tables.find((n) => /requestDetail/i.test(n));
const cols = db.prepare(`select name from pragma_table_info('${tbl}')`).all().map((c) => c.name);
const wanted = ["provider", "model", "connectionId", "status"].filter((c) => cols.includes(c));
const rows = db.prepare(`select ${wanted.join(", ")} from "${tbl}" order by rowid desc limit 80`).all();
const seats = new Set(rows.map((r) => `${r.provider}|${r.model}`));
const conns = new Set(rows.map((r) => r.connectionId));
const ok = rows.filter((r) => r.status === "success").length;

console.log(JSON.stringify({
  detailTable: tbl,
  examinedRows: rows.length,
  distinctSeats: seats.size,
  distinctConnections: conns.size,
  successRows: ok,
  errorRows: rows.length - ok,
  firstSeats: [...seats].slice(0, 10),
}, null, 2));
db.close();
