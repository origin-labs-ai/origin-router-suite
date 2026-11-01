// Ask Panda to rank the real combo pool and report how many seats it now knows.
// Expect: unknown_model entries = 0, ranking covers every seat.
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const seats = JSON.parse(db.prepare("select models from combos where name=?").get("claude-opus-5-5").models);
db.close();

const res = await fetch("http://127.0.0.1:8765/route", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    task: {
      text: "Refactor this gateway's failover loop to skip seats that just failed, keep eight agents in flight, then run the test suite and fix the failures",
      context: { repo_languages: ["javascript"], files_in_scope: 6, requires_tools: true, estimated_input_tokens: 12000 },
    },
    pool: seats,
    preferences: { mode: "max_utility", explore_epsilon: 0 },
    return_top_k: 12,
    questions: ["choice", "difficulty", "category"],
  }),
});

const data = await res.json();
const unknown = (data.filtered_out || []).filter((f) => String(f.reason).includes("unknown_model"));
const other = (data.filtered_out || []).filter((f) => !String(f.reason).includes("unknown_model"));

console.log(JSON.stringify({
  pool: seats.length,
  ranked: (data.ranking || []).length,
  unknown_model: unknown.length,
  otherFiltered: other.length,
  choice: data.choice?.model_id,
  decidedBy: data.choice?.decided_by,
  difficulty: data.difficulty?.level,
  category: data.category?.label,
  ladder: (data.escalation_ladder || []).map((l) => l.model_id),
  top: (data.ranking || []).slice(0, 8).map((r) => ({
    seat: r.model_id,
    card: r.card_id,
    p: r.p_success,
    pLower: r.p_success_lower,
    src: r.p_source,
    cost: r.est_cost_usd,
  })),
  unknownSample: unknown.slice(0, 5),
}, null, 2));
