// Memory Fabric unit tests — run against the real SQLite adapter chain with a
// temp DATA_DIR (same pattern as db-driver-chain.test.js). The memories table
// is exercised through src/lib/memoryFabric, including the settings-gated
// buildMemoryInjection seam.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-memfab-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Fresh module per test so the driver re-resolves against the temp DATA_DIR.
async function loadFabric() {
  vi.resetModules();
  return await import("@/lib/memoryFabric/index.js");
}

describe("memoryFabric rememberText", () => {
  it("stores a memory and returns the row", async () => {
    const mf = await loadFabric();
    const row = await mf.rememberText("scope-a", "The API uses cursor pagination");
    expect(row).not.toBeNull();
    expect(row.duplicated).toBe(false);
    expect(row.scope).toBe("scope-a");
    expect(row.content).toBe("The API uses cursor pagination");
    expect(row.hits).toBe(0);
    expect(row.id).toBeGreaterThan(0);
  });

  it("deduplicates on normalized content (whitespace/case-insensitive re-remember)", async () => {
    const mf = await loadFabric();
    const first = await mf.rememberText("scope-a", "Deploy via\n\n  npm run deploy", { source: "claude-code" });
    const second = await mf.rememberText("scope-a", "deploy via npm run deploy", { source: "codex" });
    expect(second.duplicated).toBe(true);
    expect(second.id).toBe(first.id);
    // Still exactly one row in the fabric, and the new source won.
    const s = await mf.stats();
    expect(s.memories).toBe(1);
    expect(second.source).toBe("codex");
  });

  it("keeps identical content in different scopes separate", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-a", "shared fact");
    await mf.rememberText("scope-b", "shared fact");
    const s = await mf.stats();
    expect(s.memories).toBe(2);
    expect(s.scopes).toBe(2);
  });

  it("refuses empty scope or empty content (fail-open null)", async () => {
    const mf = await loadFabric();
    expect(await mf.rememberText("", "content")).toBeNull();
    expect(await mf.rememberText("scope-a", "   ")).toBeNull();
    const s = await mf.stats();
    expect(s.memories).toBe(0);
  });
});

describe("memoryFabric recallText", () => {
  it("recalls most-recent-first and bumps the hit counter", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-a", "first fact");
    await mf.rememberText("scope-a", "second fact");
    const rows = await mf.recallText("scope-a");
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe("second fact");
    // Recall popularity is tracked per row.
    expect(rows[0].hits).toBe(1);
    expect(rows[0].lastHitAt).toBeTruthy();
    const again = await mf.recallText("scope-a");
    expect(again[0].hits).toBe(2);
  });

  it("filters by LIKE substring query", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-a", "the deploy script lives in scripts/deploy.sh");
    await mf.rememberText("scope-a", "tests run with vitest");
    const rows = await mf.recallText("scope-a", { query: "deploy" });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("deploy.sh");
    // No match → empty array, never a throw.
    expect(await mf.recallText("scope-a", { query: "nonexistent" })).toEqual([]);
  });

  it("clamps limit to the MAX_RECALL_LIMIT ceiling (50)", async () => {
    const mf = await loadFabric();
    for (let i = 0; i < 55; i++) await mf.rememberText("bulk", `fact number ${i}`);
    expect((await mf.recallText("bulk", { limit: 500 })).length).toBe(50);
    expect((await mf.recallText("bulk", { limit: 5 })).length).toBe(5);
    // Garbage limit falls back to the default page size.
    expect((await mf.recallText("bulk", { limit: "abc" })).length).toBe(10);
  });

  it("returns [] for unknown/empty scopes", async () => {
    const mf = await loadFabric();
    expect(await mf.recallText("never-used")).toEqual([]);
    expect(await mf.recallText("")).toEqual([]);
  });
});

describe("memoryFabric forgetText", () => {
  it("deletes by id and reports whether anything was removed", async () => {
    const mf = await loadFabric();
    const row = await mf.rememberText("scope-a", "forgettable fact");
    expect(await mf.forgetText(row.id)).toBe(true);
    expect(await mf.recallText("scope-a")).toEqual([]);
    expect(await mf.forgetText(row.id)).toBe(false);
    // Non-numeric ids are refused, not thrown on.
    expect(await mf.forgetText("abc")).toBe(false);
    expect(await mf.forgetText(null)).toBe(false);
  });
});

describe("memoryFabric listScopes + stats", () => {
  it("groups by scope with counts, hits and last activity", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-b", "b fact");
    await mf.rememberText("scope-a", "a1 fact");
    await mf.rememberText("scope-a", "a2 fact");
    await mf.recallText("scope-a");
    const scopes = await mf.listScopes();
    expect(scopes.map((s) => s.scope)).toEqual(["scope-a", "scope-b"]);
    expect(scopes[0].count).toBe(2);
    expect(scopes[0].hits).toBe(2); // two rows recalled once each
    expect(scopes[1].hits).toBe(0);
    expect(scopes[0].lastUpdatedAt).toBeTruthy();
  });

  it("reports whole-fabric totals", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-a", "a fact");
    await mf.rememberText("scope-b", "b fact");
    await mf.recallText("scope-b");
    const s = await mf.stats();
    expect(s.memories).toBe(2);
    expect(s.scopes).toBe(2);
    expect(s.hits).toBe(1);
    expect(s.maxRecallLimit).toBe(50);
  });
});

describe("deriveScopeKey", () => {
  it("hashes fingerprint + first user message into a stable 16-hex key", async () => {
    const mf = await loadFabric();
    const opts = {
      headers: { "x-session-id": "agent-1" },
      body: { messages: [{ role: "user", content: "fix the login bug" }] },
    };
    const key = mf.deriveScopeKey(opts);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    // Same inputs → same scope (that is the whole point of the fabric).
    expect(mf.deriveScopeKey(opts)).toBe(key);
  });

  it("differs when the fingerprint or first user message differs", async () => {
    const mf = await loadFabric();
    const base = {
      headers: { "x-session-id": "agent-1" },
      body: { messages: [{ role: "user", content: "fix the login bug" }] },
    };
    const otherAgent = mf.deriveScopeKey({ ...base, headers: { "x-session-id": "agent-2" } });
    const otherTask = mf.deriveScopeKey({ ...base, body: { messages: [{ role: "user", content: "write a poem" }] } });
    const baseKey = mf.deriveScopeKey(base);
    expect(otherAgent).not.toBe(baseKey);
    expect(otherTask).not.toBe(baseKey);
  });

  it("reads the first user message from block-style content and falls back to headers only", async () => {
    const mf = await loadFabric();
    const blockKey = mf.deriveScopeKey({
      headers: { "user-agent": "ua-1" },
      body: { messages: [{ role: "assistant", content: "hi" }, { role: "user", content: [{ type: "text", text: "block style" }] }] },
    });
    expect(blockKey).toMatch(/^[0-9a-f]{16}$/);
    // No message at all — the fingerprint alone still scopes the key.
    expect(mf.deriveScopeKey({ headers: { "user-agent": "ua-1" }, body: {} })).toMatch(/^[0-9a-f]{16}$/);
    // Nothing to hash → null.
    expect(mf.deriveScopeKey({})).toBeNull();
  });
});

describe("buildMemoryInjection", () => {
  it("returns null while the feature is off (default) or settings are missing", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-a", "a fact");
    // Default settings shape from settingsRepo: { memoryFabric: { enabled: false } }
    expect(await mf.buildMemoryInjection({ memoryFabric: { enabled: false } }, { scopeKey: "scope-a" })).toBeNull();
    expect(await mf.buildMemoryInjection({}, { scopeKey: "scope-a" })).toBeNull();
    expect(await mf.buildMemoryInjection(undefined, { scopeKey: "scope-a" })).toBeNull();
  });

  it("returns a string containing the memories when enabled and the scope has notes", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-a", "the deploy script is scripts/deploy.sh");
    await mf.rememberText("scope-a", "tests run with vitest");
    const text = await mf.buildMemoryInjection(
      { memoryFabric: { enabled: true } },
      { scopeKey: "scope-a" },
    );
    expect(typeof text).toBe("string");
    expect(text).toContain("deploy.sh");
    expect(text).toContain("vitest");
  });

  it("returns null when the scope is empty or unresolvable", async () => {
    const mf = await loadFabric();
    await mf.rememberText("scope-a", "a fact");
    const enabled = { memoryFabric: { enabled: true } };
    expect(await mf.buildMemoryInjection(enabled, { scopeKey: "empty-scope" })).toBeNull();
    expect(await mf.buildMemoryInjection(enabled, {})).toBeNull(); // no scopeKey, no headers/body
  });

  it("can derive the scope from headers + body like the handlers will", async () => {
    const mf = await loadFabric();
    const headers = { "x-session-id": "agent-1" };
    const body = { messages: [{ role: "user", content: "scope derivation test" }] };
    await mf.rememberText(mf.deriveScopeKey({ headers, body }), "remembered across agents");
    const text = await mf.buildMemoryInjection({ memoryFabric: { enabled: true } }, { headers, body });
    expect(text).toContain("remembered across agents");
  });
});
