// Live 8-agent test against the installed router (port 20128), the way Claude
// Code actually calls it: streaming, tools present, model alias (not provider/
// model). Proves three things at once:
//   1. eight concurrent agent requests are all served (no rejection, no error)
//   2. the fleet spreads across accounts instead of stampeding one credential
//   3. no upstream API error reaches the client
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:20128";
const KEY = process.env.OR_KEY || "sk-bb77cc2e507b3ea0-fhtrtm-3d33d160";
const AGENTS = 8;

// Claude Code shape: block content, top-level system, tools, streaming.
const body = (model) => ({
  model,
  max_tokens: 24,
  stream: true,
  system: [{ type: "text", text: "You are a concise assistant. Answer in one word." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }],
  tools: [{
    name: "read_file",
    description: "Read a file from disk",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }],
});

async function agent(index, model) {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body(model)),
  });
  const text = await res.text();
  const ms = Date.now() - started;
  const errorFrame = /"type"\s*:\s*"error"/.test(text) || /"error"\s*:\s*\{/.test(text);
  const delta = (text.match(/content_block_delta/g) || []).length;
  return {
    index,
    status: res.status,
    ms,
    errorFrame,
    sawMessageStart: text.includes("message_start"),
    sawStop: text.includes("message_stop") || text.includes("[DONE]"),
    deltas: delta,
    bytes: text.length,
  };
}

const model = process.env.OR_MODEL || "claude-opus-5-5";
const started = Date.now();
const results = await Promise.all(Array.from({ length: AGENTS }, (_, i) => agent(i, model)));
const wallMs = Date.now() - started;

console.log(JSON.stringify({
  model,
  agents: AGENTS,
  wallMs,
  statuses: results.map((r) => r.status),
  allStreamed: results.every((r) => r.sawMessageStart && !r.errorFrame),
  anyErrorFrame: results.some((r) => r.errorFrame),
  perAgentMs: results.map((r) => r.ms),
  deltas: results.map((r) => r.deltas),
}, null, 2));

// Which accounts actually carried the traffic?
const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
try {
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((t) => t.name);
  const detailTable = tables.find((n) => /requestDetail/i.test(n)) || tables.find((n) => /request/i.test(n));
  if (detailTable) {
    const cols = db.prepare(`select * from pragma_table_info('${detailTable}')`).all().map((c) => c.name);
    const since = new Date(started - 2000).toISOString();
    const timeCol = cols.find((c) => /createdAt|timestamp|time/i.test(c));
    const rows = db.prepare(`select * from "${detailTable}" order by rowid desc limit 24`).all()
      .filter((row) => !timeCol || String(row[timeCol] || "") >= since.slice(0, 19));
    console.log("served by (last rows from", detailTable + "):");
    const interesting = cols.filter((c) => /model|provider|account|connection|status|duration|tokens/i.test(c));
    for (const row of rows.slice(0, 12)) {
      console.log("  " + interesting.map((c) => `${c}=${String(row[c]).slice(0, 28)}`).join(" "));
    }
    if (rows.length === 0) console.log("  (no rows in window; cols: " + cols.join(", ") + ")");
  }
  // Usage rollup also records pending/active per connection.
  const usage = db.prepare("select name from sqlite_master where type='table'").all().map((t) => t.name).filter((n) => /usage/i.test(n));
  console.log("usage tables:", usage.join(", "));
} catch (error) {
  console.log("db inspect failed:", error.message);
} finally {
  db.close();
}
