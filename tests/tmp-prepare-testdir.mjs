import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const srcDir = path.join(os.homedir(), ".or");
const outDir = path.join(os.homedir(), ".or-test");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "db"), { recursive: true });

const srcDb = new DatabaseSync(path.join(srcDir, "db", "data.sqlite"), { readOnly: true });
srcDb.exec(`VACUUM INTO '${path.join(outDir, "db", "data.sqlite").replaceAll("'", "''")}'`);
srcDb.close();

const db = new DatabaseSync(path.join(outDir, "db", "data.sqlite"));
const row = db.prepare("select data from settings where id = 1").get();
const settings = JSON.parse(row?.data || "{}");
settings.requireLogin = false;
delete settings.password;
settings.tunnelEnabled = false;
delete settings.tunnelUrl;
settings.tailscaleEnabled = false;
delete settings.tailscaleUrl;
settings.lanAccessEnabled = false;
db.prepare("update settings set data = ? where id = 1").run(JSON.stringify(settings));
db.close();

for (const file of ["model-catalog.json", "model-catalog-raw.json", "jwt-secret", "machine-id"]) {
  const from = path.join(srcDir, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, file));
}
console.log("test data dir ready:", outDir);
