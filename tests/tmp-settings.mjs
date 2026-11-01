import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".or", "db", "data.sqlite");
const db = new DatabaseSync(file, { readOnly: true });
console.log(db.prepare("select * from settings").all());
console.log(db.prepare("select * from apiKeys").all());
db.close();
