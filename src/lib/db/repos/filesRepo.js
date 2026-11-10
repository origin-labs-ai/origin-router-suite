import path from "node:path";
import fs from "node:fs";
import { makeKv } from "../helpers/kvStore.js";
import { DATA_DIR } from "@/lib/dataDir.js";
import { generateId } from "@/shared/utils/index.js";

const kv = makeKv("files");
const FILES_DIR = path.join(DATA_DIR, "files");

function ensureFilesDir() {
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
}

function safeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function contentPath(id) {
  const safe = safeId(id);
  return safe ? path.join(FILES_DIR, safe) : null;
}

function publicFile(record) {
  if (!record) return null;
  const { content, ...meta } = record;
  return meta;
}

/**
 * Persist an uploaded file's bytes and metadata. Content lives beside the
 * database (DATA_DIR/files) so large uploads never inflate the SQLite file;
 * only the metadata row goes through the kv store.
 */
export async function createFile({ filename, purpose = "batch", bytes, contentType = "application/octet-stream", content }) {
  const id = `file-${generateId()}`;
  ensureFilesDir();
  const target = contentPath(id);
  if (!target) throw new Error("Invalid file id");
  fs.writeFileSync(target, content);
  const record = {
    id,
    object: "file",
    bytes: typeof bytes === "number" ? bytes : Buffer.byteLength(content),
    created_at: Math.floor(Date.now() / 1000),
    filename: filename || "upload.bin",
    purpose,
    contentType,
  };
  await kv.set(id, record);
  return publicFile(record);
}

export async function getFile(id) {
  return publicFile(await kv.get(id));
}

export async function getFileRecord(id) {
  return await kv.get(id);
}

export async function getFileContent(id) {
  const target = contentPath(id);
  if (!target || !fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

export async function listFiles({ purpose } = {}) {
  const all = await kv.getAll();
  const records = Object.values(all).filter((r) => r && r.id);
  const filtered = purpose ? records.filter((r) => r.purpose === purpose) : records;
  return filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).map(publicFile);
}

export async function deleteFile(id) {
  const target = contentPath(id);
  if (target && fs.existsSync(target)) {
    try { fs.unlinkSync(target); } catch { /* best effort */ }
  }
  await kv.remove(id);
  return { id, object: "file", deleted: true };
}
