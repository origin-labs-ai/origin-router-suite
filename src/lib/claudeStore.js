import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Claude by Origin keeps its own store, separate from the router database:
//   ~/.claude/origin/sessions.db      sessions + messages + settings
//   ~/.claude/origin/attachments/     uploaded files
// Nothing here is shared with the dashboard's ~/.or database.
export function claudeHome() {
  return process.env.ORIGIN_CLAUDE_HOME || path.join(os.homedir(), ".claude", "origin");
}

let database = null;

function getDb() {
  if (database) return database;
  const home = claudeHome();
  fs.mkdirSync(path.join(home, "attachments"), { recursive: true });
  const db = new DatabaseSync(path.join(home, "sessions.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  database = db;
  return db;
}

const now = () => new Date().toISOString();

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    model: row.model || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    meta: row.meta ? JSON.parse(row.meta) : {},
    createdAt: row.created_at,
  };
}

export function listSessions(limit = 100) {
  const rows = getDb().prepare(
    "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?",
  ).all(limit);
  return rows.map(rowToSession);
}

export function getSession(id) {
  return rowToSession(getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id));
}

export function createSession({ title = "New chat", model = "" } = {}) {
  const session = {
    id: crypto.randomUUID(),
    title,
    model,
    createdAt: now(),
    updatedAt: now(),
  };
  getDb().prepare(
    "INSERT INTO sessions(id, title, model, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  ).run(session.id, session.title, session.model, session.createdAt, session.updatedAt);
  return session;
}

export function updateSession(id, patch = {}) {
  const current = getSession(id);
  if (!current) return null;
  const next = {
    title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim().slice(0, 120) : current.title,
    model: typeof patch.model === "string" ? patch.model : current.model,
    updatedAt: now(),
  };
  getDb().prepare(
    "UPDATE sessions SET title = ?, model = ?, updated_at = ? WHERE id = ?",
  ).run(next.title, next.model, next.updatedAt, id);
  return getSession(id);
}

export function deleteSession(id) {
  const db = getDb();
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return (result.changes ?? 0) > 0;
}

export function listMessages(sessionId) {
  return getDb().prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
  ).all(sessionId).map(rowToMessage);
}

export function appendMessage(sessionId, { role, content, meta = {} }) {
  const message = {
    id: crypto.randomUUID(),
    sessionId,
    role,
    content,
    meta,
    createdAt: now(),
  };
  getDb().prepare(
    "INSERT INTO messages(id, session_id, role, content, meta, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  ).run(message.id, sessionId, role, content, JSON.stringify(meta), message.createdAt);
  getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(message.createdAt, sessionId);
  return message;
}

export function deleteMessage(sessionId, messageId) {
  const result = getDb().prepare(
    "DELETE FROM messages WHERE id = ? AND session_id = ?",
  ).run(messageId, sessionId);
  return (result.changes ?? 0) > 0;
}

export function getSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function setSettings(patch = {}) {
  const db = getDb();
  for (const [key, value] of Object.entries(patch)) {
    db.prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, JSON.stringify(value));
  }
  return getSettings();
}
