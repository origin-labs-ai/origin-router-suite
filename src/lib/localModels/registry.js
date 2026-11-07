// Local model registry — the "+ Add model file" flow.
//
// The user often already has model weights on disk (a .gguf from a torrent, a
// .safetensors from a previous install). Registration records the PATH in the
// `localModels` SQLite table and nothing else: no copying, no moving, no
// touching the file. The user's file stays exactly where it is.
//
// All SQL goes through the repo's parameterized db adapter — every statement
// binds `?` placeholders, never string interpolation.

import fs from "node:fs";
import path from "path";
import { getAdapter } from "@/lib/db/driver.js";

// Extensions we accept. Everything else is rejected with a message that names
// the accepted set — the common failure is a .part/.txt downloaded by accident,
// and the user should learn that from the error, not from silence.
export const SUPPORTED_EXTENSIONS = [".gguf", ".safetensors", ".bin", ".ollama"];

function hasSupportedExtension(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

// Row → plain object, mirroring the repos' rowToX convention.
function rowToModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    path: row.path,
    sizeBytes: row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
    addedAt: row.addedAt,
    updatedAt: row.updatedAt,
  };
}

// Register an existing model file. Validates (exists, is a file, supported
// extension), then INSERTs the path. Throws plain Errors with human messages —
// the API route maps them to 400 so the form shows them inline.
//   { path: "D:/models/qwen2.5-7b-q4_k_m.gguf", name?: "Qwen 2.5 7B" }
// `name` is optional; the file basename (sans extension) is the fallback.
export async function registerLocalFile({ path: filePath, name } = {}) {
  // --- input validation (all synchronous, all cheap) ---
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("A file path is required");
  }
  const cleanPath = path.resolve(filePath.trim());
  if (!hasSupportedExtension(cleanPath)) {
    throw new Error(`Unsupported file type — expected one of: ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  if (typeof name !== "undefined" && name !== null && typeof name !== "string") {
    throw new Error("Name must be a string");
  }
  const cleanName = (typeof name === "string" ? name.trim() : "") || path.basename(cleanPath, path.extname(cleanPath));
  if (!cleanName) {
    throw new Error("A model name is required");
  }

  // --- file validation: the registered path must point at a real file ---
  let stat;
  try {
    stat = fs.statSync(cleanPath);
  } catch {
    throw new Error("File not found — check the path");
  }
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }

  // --- record it: parameterized INSERT, nothing copied ---
  const db = await getAdapter();
  const now = new Date().toISOString();
  const result = db.run(
    `INSERT INTO localModels(name, source, path, sizeBytes, addedAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [cleanName, "file", cleanPath, Number.isFinite(stat.size) ? stat.size : null, now, now]
  );
  const row = db.get(`SELECT * FROM localModels WHERE id = ?`, [result?.lastInsertRowid]);
  return rowToModel(row);
}

// Everything the user has registered, oldest first (stable table order).
export async function listLocalModels() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM localModels ORDER BY id ASC`);
  return rows.map(rowToModel);
}

// Remove a registration. Deletes only the DB row — the file on disk is the
// user's property and is never deleted by us.
export async function removeLocalModel(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM localModels WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
