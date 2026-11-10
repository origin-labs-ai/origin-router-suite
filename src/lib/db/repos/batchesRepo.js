import { makeKv } from "../helpers/kvStore.js";
import { generateId } from "@/shared/utils/index.js";

const kv = makeKv("batches");

function publicBatch(record) {
  if (!record) return null;
  return { ...record };
}

export async function createBatch({ input_file_id, endpoint, completion_window = "24h", metadata = null }) {
  const id = `batch_${generateId()}`;
  const now = Math.floor(Date.now() / 1000);
  const record = {
    id,
    object: "batch",
    endpoint: endpoint || "/v1/chat/completions",
    input_file_id,
    completion_window,
    status: "validating",
    output_file_id: null,
    error_file_id: null,
    created_at: now,
    in_progress_at: null,
    finalizing_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    request_counts: { total: 0, completed: 0, failed: 0 },
    metadata: metadata || null,
    errors: null,
  };
  await kv.set(id, record);
  return publicBatch(record);
}

export async function getBatch(id) {
  return publicBatch(await kv.get(id));
}

export async function listBatches({ limit = 20 } = {}) {
  const all = await kv.getAll();
  const records = Object.values(all).filter((r) => r && r.id);
  return records
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map(publicBatch);
}

export async function updateBatch(id, patch) {
  const current = await kv.get(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  await kv.set(id, next);
  return publicBatch(next);
}

export async function cancelBatch(id) {
  const current = await kv.get(id);
  if (!current) return null;
  if (["completed", "failed", "cancelled", "expired"].includes(current.status)) {
    return publicBatch(current);
  }
  return updateBatch(id, {
    status: "cancelled",
    cancelled_at: Math.floor(Date.now() / 1000),
  });
}
