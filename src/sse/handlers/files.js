import { Buffer } from "node:buffer";
import { extractApiKey, isValidApiKey } from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { createFile, getFile, getFileContent, listFiles, deleteFile } from "@/lib/db/repos/filesRepo.js";
import * as log from "../utils/logger.js";

// OpenAI-compatible file store. Content is kept beside the database
// (DATA_DIR/files) and only metadata goes through SQLite; batches consume
// these files by id.

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export function preflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
    { error: { message: `No such file: ${id}`, type: "invalid_request_error", param: "id", code: "file_not_found" } },
    404,
  );
}

/** POST /v1/files — multipart upload (`file`, optional `purpose`). */
export async function handleFileUpload(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;

  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");
  }
  const purpose = typeof form.get("purpose") === "string" ? form.get("purpose") : "batch";
  const content = Buffer.from(await file.arrayBuffer());
  if (!content.length) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Uploaded file is empty");

  const record = await createFile({
    filename: file.name || "upload.bin",
    purpose,
    bytes: content.length,
    contentType: file.type || "application/octet-stream",
    content,
  });
  log.info("FILES", `Stored ${record.id} (${record.bytes} bytes, purpose=${purpose})`);
  return jsonResponse(record);
}

/** GET /v1/files?purpose= — list uploaded files. */
export async function handleFileList(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const { searchParams } = new URL(request.url);
  const data = await listFiles({ purpose: searchParams.get("purpose") || undefined });
  return jsonResponse({ object: "list", data });
}

/** GET /v1/files/{id} — file metadata. */
export async function handleFileGet(request, id) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const record = await getFile(id);
  return record ? jsonResponse(record) : notFound(id);
}

/** GET /v1/files/{id}/content — raw file bytes. */
export async function handleFileContent(request, id) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const content = await getFileContent(id);
  if (!content) return notFound(id);
  const record = await getFile(id);
  return new Response(content, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": record?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${record?.filename || id}"`,
    },
  });
}

/** DELETE /v1/files/{id} — remove metadata and bytes. */
export async function handleFileDelete(request, id) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const record = await getFile(id);
  if (!record) return notFound(id);
  return jsonResponse(await deleteFile(id));
}
