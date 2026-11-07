// A2A — Agent-to-Agent protocol surface (v0.3-style, JSON-RPC 2.0).
//
// The references shipped a full A2A server (task manager, skills engine,
// SSE streaming, combo attribution). v0.6.000 lands the deterministic core:
// the Agent Card, a bounded in-memory task manager with the standard states,
// and JSON-RPC methods over /a2a. Streaming and the skills engine are the
// documented next step (the fusion pack's "a2a" category upgrades this in
// place — same module, more features).
//
// House rules: fail-open, bounded state, no credentials in code.

// ─── Agent Card ──────────────────────────────────────────────────────────────

export function buildAgentCard({ baseUrl = "" } = {}) {
  return {
    name: "OriginRouter",
    description: "Local-first AI gateway: 24 routing strategies, OriginFold context folding, 142 providers.",
    url: baseUrl ? `${baseUrl}/a2a` : "/a2a",
    version: "0.6.000",
    capabilities: {
      streaming: false, // the fusion pack upgrades this in place
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "smart-routing",
        name: "Smart Routing",
        description: "Resolve how a combo would route a prompt across its seats.",
        examples: ["route this prompt through my daily combo"],
      },
      {
        id: "quota-management",
        name: "Quota Management",
        description: "Report seat health and quota-family strategy states.",
        examples: ["which seats are degraded?"],
      },
      {
        id: "token-optimization",
      name: "Token Optimization",
        description: "OriginFold fold stats and the token saver's compression report.",
        examples: ["how many tokens did folding save?"],
      },
    ],
  };
}

// ─── Task manager ────────────────────────────────────────────────────────────

const TASKS_CAP = 500;
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const tasks = new Map(); // id → task

function sweep(now) {
  for (const [k, t] of tasks) {
    if (now - t.createdAt > TASK_TTL_MS) tasks.delete(k);
  }
  while (tasks.size > TASKS_CAP) {
    const oldest = tasks.keys().next().value;
    if (oldest === undefined) break;
    tasks.delete(oldest);
  }
}

let nextTaskId = 1;

export function createTask({ skill, input, executor } = {}) {
  const now = Date.now();
  const id = `task-${Date.now().toString(36)}-${nextTaskId++}`;
  const task = {
    id,
    skill: String(skill || "smart-routing"),
    state: "submitted",
    input: input ?? null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    // The executor runs async and drives the state machine.
    _run: async () => {
      try {
        task.state = "working";
        task.updatedAt = Date.now();
        const result = typeof executor === "function" ? await executor(input) : { note: "no executor bound" };
        task.result = result;
        task.state = "completed";
      } catch (err) {
        task.error = String(err?.message || err);
        task.state = "failed";
      }
      task.updatedAt = Date.now();
    },
  };
  tasks.set(id, task);
  sweep(now);
  return task;
}

export function getTask(id) {
  return tasks.get(String(id || "")) || null;
}

export function cancelTask(id) {
  const task = tasks.get(String(id || ""));
  if (!task) return null;
  if (task.state === "submitted" || task.state === "working") {
    task.state = "failed";
    task.error = "cancelled";
    task.updatedAt = Date.now();
  }
  return task;
}

export function taskStats() {
  const now = Date.now();
  sweep(now);
  const states = {};
  for (const t of tasks.values()) states[t.state] = (states[t.state] || 0) + 1;
  return { total: tasks.size, states };
}

// ─── Skill executors (deterministic; reuse the MCP tool implementations) ────

async function resolveExecutor(skill, input) {
  // smart-routing → the routing plan (same deterministic plan the MCP
  // surface exposes). Others are honest stubs until their packs land.
  if (skill === "smart-routing") {
    const { orderSeats } = await import("open-sse/services/comboOrderers.js");
    const { normalizeStrategy } = await import("@/lib/routing/strategies.js");
    const strategy = normalizeStrategy(input?.strategy || "auto");
    const seats = Array.isArray(input?.seats) ? input.seats.map(String) : [];
    const ordered = orderSeats(seats, strategy, { comboName: "__a2a__", body: { messages: [{ role: "user", content: String(input?.prompt || "") }] } });
    return async () => ({ strategy, seats: ordered });
  }
  return async () => ({ note: `skill "${skill}" executes via its fusion pack when installed` });
}

/**
 * Submit a message/task: creates the task and starts its executor.
 * @returns {{ task: object }}
 */
export async function sendMessage({ skill, input } = {}) {
  const executor = await resolveExecutor(skill, input);
  const task = createTask({ skill, input, executor });
  // Fire-and-forget: the JSON-RPC response carries the task handle; the
  // client polls tasks/get (or the fusion pack adds streaming later).
  task._run().catch(() => { /* the executor itself records the failure */ });
  return { task: publicTask(task) };
}

function publicTask(task) {
  const { _run, ...rest } = task;
  return rest;
}

export { publicTask };
