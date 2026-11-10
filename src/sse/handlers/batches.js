import { Buffer } from "node:buffer";
import { extractApiKey, isValidApiKey } from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { handleChat } from "./chat.js";
import { handleEmbeddings } from "./embeddings.js";
import { handleCompletions } from "./derived/textIntelligence.js";
import {
  createFile,
  getFile,
  getFileContent,
} from "@/lib/db/repos/filesRepo.js";
import {
  createBatch,
  getBatch,
  listBatches,
  updateBatch,
  cancelBatch,
} from "@/lib/db/repos/batchesRepo.js";
import * as log from "../utils/logger.js";

// OpenAI-compatible batch runner. A batch consumes a JSONL file produced by
// /v1/files (one {custom_id, method, url, body} per line), replays each line
// through the same pipeline as its live endpoint, and writes the JSONL output
// and error files back into the file store.

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };
const SUPPORTED_ENDPOINTS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/completions",
]);
const ACTIVE_STATUSES = new Set(["validating", "in_progress", "finalizing"]);

export function preflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

async function requireKey(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;
  const apiKey = extractApiKey(request);
  if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  const valid = await isValidApiKey(apiKey);
  if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  return null;
}

function notFound(id) {
  return jsonResponse(
    { error: { message: `No such batch: ${id}`, type: "invalid_request_error", param: "id", code: "batch_not_found" } },
    404,
  );
}

/** Route a single JSONL line to the live endpoint that owns it. */
async function dispatchBatchRequest(originalRequest, url, body) {
  const request = new Request(new URL(url, new URL(originalRequest.url).origin), {
    method: "POST",
    headers: originalRequest.headers,
    body: JSON.stringify(body),
    signal: originalRequest.signal,
  });
  if (url === "/v1/embeddings") return handleEmbeddings(request);
  if (url === "/v1/completions") return handleCompletions(request);
  // /v1/chat/completions and /v1/responses share the chat pipeline
  return handleChat(request);
}

/**
 * Replay a batch's JSONL through the live pipeline. Runs after the response is
 * returned; failures are written to the error file rather than thrown.
 */
export async function processBatch(batchId, originalRequest) {
  const batch = await getBatch(batchId);
  if (!batch) return;
  const input = await getFileContent(batch.input_file_id);
  if (!input) {
    await updateBatch(batchId, {
      status: "failed",
      failed_at: Math.floor(Date.now() / 1000),
      errors: { message: "Input file not found" },
    });
    return;
  }

  await updateBatch(batchId, {
    status: "in_progress",
    in_progress_at: Math.floor(Date.now() / 1000),
  });

  const lines = input.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  const output = [];
  const errors = [];
  let completed = 0;
  let failed = 0;

  for (const line of lines) {
    const current = await getBatch(batchId);
    if (!current || current.status === "cancelled") return;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      failed += 1;
      errors.push(JSON.stringify({ error: { message: "Invalid JSONL line", status_code: 400 } }));
      continue;
    }

    const customId = entry?.custom_id || `line-${output.length + errors.length}`;
    const url = entry?.url || batch.endpoint;
    try {
      if (!SUPPORTED_ENDPOINTS.has(url)) throw new Error(`Unsupported batch endpoint: ${url}`);
      const response = await dispatchBatchRequest(originalRequest, url, entry?.body ?? {});
      const text = await response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (response.ok) {
        completed += 1;
        output.push(JSON.stringify({ id: customId, custom_id: customId, response: { status_code: response.status, body: parsed }, error: null }));
      } else {
        failed += 1;
        errors.push(JSON.stringify({ id: customId, custom_id: customId, response: null, error: { status_code: response.status, message: parsed?.error?.message || "Request failed" } }));
      }
    } catch (error) {
      failed += 1;
      errors.push(JSON.stringify({ id: customId, custom_id: customId, response: null, error: { status_code: 500, message: error?.message || "Request failed" } }));
    }
  }

  const outputFile = output.length
    ? await createFile({
        filename: `${batchId}-output.jsonl`,
        purpose: "batch_output",
        contentType: "application/jsonl",
        content: Buffer.from(`${output.join("\n")}\n`),
      })
    : null;
  const errorFile = errors.length
    ? await createFile({
        filename: `${batchId}-errors.jsonl`,
        purpose: "batch_output",
        contentType: "application/jsonl",
        content: Buffer.from(`${errors.join("\n")}\n`),
      })
    : null;

  const now = Math.floor(Date.now() / 1000);
  await updateBatch(batchId, {
    status: failed > 0 && completed === 0 ? "failed" : "completed",
    finalizing_at: now,
    completed_at: now,
    output_file_id: outputFile?.id || null,
    error_file_id: errorFile?.id || null,
    request_counts: { total: lines.length, completed, failed },
    errors: failed > 0 ? { count: failed } : null,
  });
  log.info("BATCHES", `Batch ${batchId} finished (${completed} ok, ${failed} failed)`);
}

/** POST /v1/batches — create a batch over an uploaded JSONL file. */
export async function handleBatchCreate(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!body?.input_file_id) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input_file_id");
  const endpoint = body.endpoint || "/v1/chat/completions";
  if (!SUPPORTED_ENDPOINTS.has(endpoint)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unsupported endpoint: ${endpoint}`);
  }
  const file = await getFile(body.input_file_id);
  if (!file) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No such file: ${body.input_file_id}`);

  const batch = await createBatch({
    input_file_id: body.input_file_id,
    endpoint,
    completion_window: body.completion_window,
    metadata: body.metadata,
  });

  // Fire and forget — the client polls GET /v1/batches/{id}.
  processBatch(batch.id, request).catch((error) => {
    log.warn("BATCHES", `Batch ${batch.id} crashed: ${error?.message || error}`);
    updateBatch(batch.id, {
      status: "failed",
      failed_at: Math.floor(Date.now() / 1000),
      errors: { message: error?.message || "Batch crashed" },
    }).catch(() => {});
  });

  return jsonResponse(batch);
}

/** GET /v1/batches — list batches. */
export async function handleBatchList(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const { searchParams } = new URL(request.url);
  const data = await listBatches({ limit: searchParams.get("limit") });
  return jsonResponse({ object: "list", data });
}

/** GET /v1/batches/{id} — batch status. */
export async function handleBatchGet(request, id) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const batch = await getBatch(id);
  return batch ? jsonResponse(batch) : notFound(id);
}

/** POST /v1/batches/{id}/cancel — cancel an active batch. */
export async function handleBatchCancel(request, id) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const batch = await getBatch(id);
  if (!batch) return notFound(id);
  if (!ACTIVE_STATUSES.has(batch.status)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Batch ${id} is ${batch.status} and cannot be cancelled`);
  }
  return jsonResponse(await cancelBatch(id));
}
