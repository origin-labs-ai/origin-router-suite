import { makeKv } from "../helpers/kvStore.js";
import { generateId } from "@/shared/utils/index.js";

const kv = makeKv("agents");

function publicAgent(record) {
  if (!record) return null;
  return { ...record };
}

export async function createAgent({ name, model, instructions = "", tools = [] } = {}) {
  const id = `agent_${generateId()}`;
  const now = Math.floor(Date.now() / 1000);
  const record = {
    id,
    object: "agent",
    name: name || id,
    model: model || null,
    instructions: typeof instructions === "string" ? instructions : "",
    tools: Array.isArray(tools) ? tools.map(String) : [],
    created_at: now,
    updated_at: now,
  };
  await kv.set(id, record);
  return publicAgent(record);
}

export async function getAgent(id) {
  return publicAgent(await kv.get(id));
}

export async function listAgents() {
  const all = await kv.getAll();
  return Object.values(all)
    .filter((r) => r && r.id)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
    .map(publicAgent);
}

export async function updateAgent(id, patch) {
  const current = await kv.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, id, updated_at: Math.floor(Date.now() / 1000) };
  await kv.set(id, next);
  return publicAgent(next);
}

export async function deleteAgent(id) {
  await kv.remove(id);
  return { id, object: "agent", deleted: true };
}
