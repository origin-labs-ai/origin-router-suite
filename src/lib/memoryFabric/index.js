// Memory Fabric — a persistent, shared context layer across coding agents.
//
// Agents that talk to the router (Claude Code, Codex, Cursor, …) each keep
// their own private memory, so the same project decision gets re-explained to
// every tool on every session. This module gives them one shared shelf: any
// agent can `rememberText()` a fact under a scope, and later requests in the
// same scope can `recallText()` it back — or receive it automatically through
// buildMemoryInjection(), the seam chat handlers call before dispatch.
//
// Design notes:
// - Storage is the `memories` SQLite table (src/lib/db/schema.js) via the same
//   getAdapter() pattern the other repos use — no new driver, no new files.
// - A `scope` is an opaque key derived from the client fingerprint + first
//   user message (see deriveScopeKey), so each conversation only recalls its
//   own slice and different agents sharing a conversation see the same slice.
// - Bounded by contract: recall reads at most MAX_RECALL_LIMIT rows, dedup
//   scans are scoped to one scope's rows, and nothing is held in module state
//   (every call goes straight to SQLite), so there is no cache to grow.
// - Fail-open everywhere: callers (route handlers, injection seam) get an
//   empty/null answer on any error — a broken memory shelf must never take
//   down a chat completion.

import crypto from "node:crypto";
import { getAdapter } from "../db/driver.js";

// Hard ceiling on any single recall — the injection prompt is prepended to
// real user traffic, so an unbounded SELECT here would be a token bomb.
export const MAX_RECALL_LIMIT = 50;
// Default page size when the caller does not care.
export const DEFAULT_RECALL_LIMIT = 10;

// ---------------------------------------------------------------------------
// Normalization / hashing helpers
// ---------------------------------------------------------------------------

// Collapse all whitespace runs to single spaces, trim, and case-fold: memories
// pasted with different indentation or casing are the same memory to an agent.
// Used ONLY as the dedup identity — stored content stays verbatim.
function normalizeContent(content) {
  return String(content ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Dedup identity = SHA-256 of the normalized content. Computed on the fly for
// each candidate row (the table has no hash column on purpose — the schema
// stays minimal); scope-scoped scans keep this cheap.
function contentHash(normalized) {
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// Short 16-hex-char hash, same style as open-sse/utils/sessionManager.js.
function sha16(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

// Map a DB row to the public shape (ints come back as they went in, but keep
// the conversion explicit so drivers that return strings stay honest).
function toMemory(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    scope: row.scope,
    content: row.content,
    source: row.source ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hits: Number(row.hits ?? 0),
    lastHitAt: row.lastHitAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Store a memory under `scope`. Deduplicates on the normalized content hash:
 * re-remembering the same fact (even with different whitespace/casing of
 * surrounding blank lines) refreshes the existing row instead of piling up
 * copies, so recall pages never waste slots on duplicates.
 *
 * @param {string} scope - Opaque scope key (see deriveScopeKey)
 * @param {string} content - The memory text; stored verbatim
 * @param {{source?: string}} [opts] - Optional provenance label ("claude-code", "codex", …)
 * @returns {Promise<object|null>} The stored/refreshed row, or null on bad input/failure
 */
export async function rememberText(scope, content, { source = null } = {}) {
  try {
    const cleanScope = String(scope ?? "").trim();
    const normalized = normalizeContent(content);
    // An empty scope or empty memory has no recall value — refuse quietly
    // (fail-open: the caller's flow continues, just without a memory).
    if (!cleanScope || !normalized) return null;
    const hash = contentHash(normalized);
    const now = new Date().toISOString();

    const db = await getAdapter();
    let result = null;
    db.transaction(() => {
      // Dedup scan is bounded to one scope's rows — scopes are per-conversation
      // slices, so this stays small in practice.
      const existing = db.all(`SELECT id, content FROM memories WHERE scope = ?`, [cleanScope]);
      for (const row of existing) {
        if (contentHash(normalizeContent(row.content)) !== hash) continue;
        // Same memory: refresh updatedAt (it was just re-confirmed) and take a
        // newly provided source, but keep createdAt and the hit counter.
        const src = source != null && String(source).trim() ? String(source).trim() : null;
        db.run(
          `UPDATE memories SET updatedAt = ?, source = COALESCE(?, source) WHERE id = ?`,
          [now, src, row.id],
        );
        result = { ...toMemory(db.get(`SELECT * FROM memories WHERE id = ?`, [row.id])), duplicated: true };
        return;
      }
      const res = db.run(
        `INSERT INTO memories(scope, content, source, createdAt, updatedAt, hits, lastHitAt) VALUES(?, ?, ?, ?, ?, 0, NULL)`,
        [cleanScope, String(content), source != null && String(source).trim() ? String(source).trim() : null, now, now],
      );
      result = { ...toMemory(db.get(`SELECT * FROM memories WHERE id = ?`, [Number(res.lastInsertRowid)])), duplicated: false };
    });
    return result;
  } catch (error) {
    console.log("[memoryFabric] rememberText failed:", error?.message || error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * Recall memories for `scope`, most recently updated first, optionally filtered
 * by a LIKE substring `query` (case-insensitive for ASCII, per SQLite LIKE).
 * Every returned row gets its hit counter bumped — recall popularity is what
 * later tells the dashboard which memories actually matter.
 *
 * @param {string} scope - Opaque scope key
 * @param {{limit?: number, query?: string}} [opts]
 * @returns {Promise<Array<object>>} Memory rows (never throws — [] on failure)
 */
export async function recallText(scope, { limit = DEFAULT_RECALL_LIMIT, query = "" } = {}) {
  try {
    const cleanScope = String(scope ?? "").trim();
    if (!cleanScope) return [];
    // Bounded by contract: clamp whatever the caller asks for to MAX_RECALL_LIMIT.
    const asked = Number.parseInt(limit, 10);
    const capped = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_RECALL_LIMIT) : DEFAULT_RECALL_LIMIT;
    const q = typeof query === "string" ? query.trim() : "";

    const db = await getAdapter();
    // Build the SELECT once and reuse it: the post-bump re-read below must
    // return exactly the page this call decided on.
    // Escape the LIKE metacharacters so a memory containing '%' or '_' is
    // findable literally; ESCAPE '\\' marks the backslash as the escape char.
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const selectSql = like
      ? `SELECT * FROM memories WHERE scope = ? AND content LIKE ? ESCAPE '\\' ORDER BY updatedAt DESC, id DESC LIMIT ?`
      : `SELECT * FROM memories WHERE scope = ? ORDER BY updatedAt DESC, id DESC LIMIT ?`;
    const selectParams = like ? [cleanScope, like, capped] : [cleanScope, capped];

    let rows = db.all(selectSql, selectParams);

    // Hit counters bump inside one transaction so N rows don't produce N saves
    // on the sql.js fallback (each save serializes the whole DB file).
    const now = new Date().toISOString();
    if (rows.length) {
      try {
        db.transaction(() => {
          for (const row of rows) {
            db.run(`UPDATE memories SET hits = hits + 1, lastHitAt = ? WHERE id = ?`, [now, row.id]);
          }
        });
      } catch {
        // Counter is advisory — a failed bump must not lose the memories.
      }
      // Re-read so the caller sees the post-bump counters (the rows above were
      // selected before the UPDATE ran).
      rows = db.all(selectSql, selectParams);
    }
    return rows.map(toMemory);
  } catch (error) {
    console.log("[memoryFabric] recallText failed:", error?.message || error);
    return [];
  }
}

/**
 * Delete one memory by id.
 * @param {number|string} id - Memory row id
 * @returns {Promise<boolean>} true when a row was actually deleted
 */
export async function forgetText(id) {
  try {
    const numeric = Number(id);
    if (!Number.isInteger(numeric)) return false;
    const db = await getAdapter();
    const res = db.run(`DELETE FROM memories WHERE id = ?`, [numeric]);
    return Number(res.changes ?? 0) > 0;
  } catch (error) {
    console.log("[memoryFabric] forgetText failed:", error?.message || error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Aggregates (dashboard)
// ---------------------------------------------------------------------------

/**
 * One row per scope with its size, total recall hits and last activity.
 * @returns {Promise<Array<object>>} [{ scope, count, hits, lastUpdatedAt }]
 */
export async function listScopes() {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT scope, COUNT(*) AS count, COALESCE(SUM(hits), 0) AS hits, MAX(updatedAt) AS lastUpdatedAt
       FROM memories GROUP BY scope ORDER BY scope`,
    );
    return rows.map((r) => ({
      scope: r.scope,
      count: Number(r.count ?? 0),
      hits: Number(r.hits ?? 0),
      lastUpdatedAt: r.lastUpdatedAt ?? null,
    }));
  } catch (error) {
    console.log("[memoryFabric] listScopes failed:", error?.message || error);
    return [];
  }
}

/**
 * Whole-fabric counters for the dashboard header.
 * @returns {Promise<object>} { memories, scopes, hits, maxRecallLimit }
 */
export async function stats() {
  try {
    const db = await getAdapter();
    const row = db.get(
      `SELECT COUNT(*) AS memories, COUNT(DISTINCT scope) AS scopes, COALESCE(SUM(hits), 0) AS hits FROM memories`,
    );
    return {
      memories: Number(row?.memories ?? 0),
      scopes: Number(row?.scopes ?? 0),
      hits: Number(row?.hits ?? 0),
      maxRecallLimit: MAX_RECALL_LIMIT,
    };
  } catch (error) {
    console.log("[memoryFabric] stats failed:", error?.message || error);
    return { memories: 0, scopes: 0, hits: 0, maxRecallLimit: MAX_RECALL_LIMIT };
  }
}

// ---------------------------------------------------------------------------
// Scope key derivation + injection seam
// ---------------------------------------------------------------------------

// Headers that identify the calling agent/client, in priority order — same
// idea as SESSION_HEADER_KEYS in open-sse/utils/sessionManager.js.
const FINGERPRINT_HEADER_KEYS = [
  "x-session-id",
  "session-id",
  "x-client-request-id",
  "x-api-key",
  "authorization",
  "user-agent",
];

// Lowercase-key header read (clients send mixed case; Next normalizes but be
// tolerant of raw header objects passed straight from handlers).
function headerValue(headers, key) {
  if (!headers || typeof headers !== "object") return null;
  const v = headers[key] ?? headers[key.toLowerCase()];
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

// Which agent/conversation is asking? Prefer an explicit session id; fall back
// to the API key (stable per client) and finally the user agent string.
function clientFingerprint(headers) {
  for (const key of FINGERPRINT_HEADER_KEYS) {
    const v = headerValue(headers, key);
    // authorization carries a secret — hash-input only, never logged/echoed.
    if (v) return v;
  }
  return "";
}

// First user message text from an OpenAI/Anthropic-style body. Content may be
// a plain string or a block array; only text blocks carry scope-able words.
// Capped like sessionManager's text hashing so a huge first prompt cannot
// make the hash input unbounded.
const SCOPE_TEXT_CAP = 256;

function firstUserMessageText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content.trim().slice(0, SCOPE_TEXT_CAP);
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((b) => (b?.type === "text" || typeof b?.text === "string" ? b.text || "" : ""))
        .join(" ")
        .trim();
      if (text) return text.slice(0, SCOPE_TEXT_CAP);
    }
  }
  return "";
}

/**
 * Derive the memory scope for a request: hash(client fingerprint + first user
 * message), 16 hex chars — same short-hash style as resolveSessionId in
 * open-sse/utils/sessionManager.js. Two agents sending the same conversation
 * opener with the same credentials land in the same scope; everything else
 * stays isolated.
 *
 * @param {{headers?: object, body?: object}} [opts]
 * @returns {string|null} Scope key, or null when there is nothing to hash
 */
export function deriveScopeKey({ headers, body } = {}) {
  try {
    const fingerprint = clientFingerprint(headers);
    const firstUser = firstUserMessageText(body);
    if (!fingerprint && !firstUser) return null;
    return sha16(`${fingerprint}:${firstUser}`);
  } catch {
    return null;
  }
}

// Injection prompt size: a handful of memories is context, a page of them is
// noise the model has to read past on every turn.
const INJECTION_DEFAULT_LIMIT = 8;

/**
 * The injection seam chat handlers call before dispatch. Returns a plain-text
 * block the handler can prepend to the system/user turn, or null when there is
 * nothing to add.
 *
 * Gated (all fail-open to null):
 * - settings.memoryFabric.enabled must be exactly true — the feature ships
 *   OFF and only an explicit opt-in turns it on.
 * - a scope key must be resolvable (passed in, or derived from headers+body).
 * - the scope must actually have memories.
 *
 * @param {object} settings - Merged settings (settingsRepo.getSettings())
 * @param {{scopeKey?: string, headers?: object, body?: object, limit?: number}} [opts]
 * @returns {Promise<string|null>} Injection text or null
 */
export async function buildMemoryInjection(settings, opts = {}) {
  try {
    // Default OFF: undefined settings, missing flag, or explicit false all
    // mean "no injection". Only === true opts in.
    if (settings?.memoryFabric?.enabled !== true) return null;

    const scopeKey = opts.scopeKey || deriveScopeKey({ headers: opts.headers, body: opts.body });
    if (!scopeKey) return null;

    const memories = await recallText(scopeKey, { limit: opts.limit ?? INJECTION_DEFAULT_LIMIT });
    if (!memories.length) return null;

    const lines = memories.map((m) => `- ${m.content}`).join("\n");
    return [
      `[memory-fabric] Shared context recalled for this conversation (scope ${scopeKey}, ${memories.length} note${memories.length === 1 ? "" : "s"}):`,
      lines,
    ].join("\n");
  } catch {
    // A memory shelf outage must never break the chat request itself.
    return null;
  }
}
