// Runtime proof for the routing resilience layer.
//   1. a model no provider can serve still answers 200, in the client's format
//   2. eight agents in parallel are all served
//   3. a real request still works through the new least-loaded selection
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:20129";
const db = new DatabaseSync(path.join(os.homedir(), ".or-test", "db", "data.sqlite"), { readOnly: true });
const key = db.prepare("select key from apiKeys limit 1").get()?.key;
db.close();

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };

// A Claude Code shaped payload: block content + top-level system array.
const claudeBody = (model, extra = {}) => ({
  model,
  max_tokens: 16,
  stream: false,
  system: [{ type: "text", text: "Answer concisely." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }],
  ...extra,
});

const post = (body) => fetch(`${BASE}/v1/messages`, {
  method: "POST", headers, body: JSON.stringify(body),
});

const shape = async (res) => {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const text0 = Array.isArray(json?.content)
    ? json.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : "";
  return {
    status: res.status,
    isErrorEnvelope: Boolean(json?.error),
    claudeShape: json?.type === "message" && Array.isArray(json?.content),
    stopReason: json?.stop_reason || null,
    text: text0.slice(0, 60),
    raw: text.slice(0, 90),
  };
};

const report = {};

// 1. unservable model → answered, in Claude format
report.bogus = await shape(await post(claudeBody("zzznope/this-model-does-not-exist-anywhere")));

// 2. eight parallel agents on the same unservable model
const started = Date.now();
const many = await Promise.all(Array.from({ length: 8 }, () => post(claudeBody("zzznope/this-model-does-not-exist-anywhere"))));
const shapes = await Promise.all(many.map(shape));
report.parallel8 = {
  elapsedMs: Date.now() - started,
  statuses: many.map((r) => r.status),
  anyErrorEnvelope: shapes.some((s) => s.isErrorEnvelope),
  allClaudeShape: shapes.every((s) => s.claudeShape),
};

// 3. a real route, twice in parallel, to see the fleet spread over accounts
const real = await Promise.all([
  post(claudeBody("ag/gemini-3.8-flash-medium")),
  post(claudeBody("ag/gemini-3.8-flash-medium")),
]);
report.realParallel = await Promise.all(real.map(shape));

console.log(JSON.stringify(report, null, 2));
