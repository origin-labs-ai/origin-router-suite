// Shadow Cache unit tests. Each test loads a fresh module instance
// (vi.resetModules) so LRU state, counters and hydration flags reset; a temp
// DATA_DIR keeps the default file store away from any real ~/.or data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-shadow-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.useRealTimers();
});

// Fresh module per test: the cache state is module-level by design.
async function loadShadow() {
  vi.resetModules();
  return await import("open-sse/services/shadowCache.js");
}

// Minimal deterministic chat request (temperature 0, no stream, no tools).
function body(extra = {}) {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello world" }],
    temperature: 0,
    ...extra,
  };
}

function response(text = "cached answer") {
  return { id: "chatcmpl-shadow", choices: [{ message: { role: "assistant", content: text } }] };
}

describe("shadowCache store/lookup roundtrip", () => {
  it("stores a temperature=0 response and replays it verbatim", async () => {
    const sc = await loadShadow();
    const b = body();
    expect(sc.storeShadow("test-model", b, response())).toBe(true);
    expect(sc.lookupShadow("test-model", b)).toEqual(response());
    const s = sc.shadowStats();
    expect(s.stores).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.entries).toBe(1);
  });

  it("misses on a different model or different messages", async () => {
    const sc = await loadShadow();
    sc.storeShadow("test-model", body(), response());
    expect(sc.lookupShadow("other-model", body())).toBeNull();
    expect(sc.lookupShadow("test-model", body({ messages: [{ role: "user", content: "different" }] }))).toBeNull();
  });

  it("caches temperature-omitted requests separately from temperature 0", async () => {
    const sc = await loadShadow();
    // Omitting temperature is a distinct upstream request (provider default
    // sampling) — it is eligible, but keys differently from temperature: 0.
    const noTemp = { messages: [{ role: "user", content: "hello world" }] };
    sc.storeShadow("test-model", noTemp, response("default sampling"));
    expect(sc.lookupShadow("test-model", noTemp)).toEqual(response("default sampling"));
    expect(sc.lookupShadow("test-model", body())).toBeNull();
  });

  it("keys on head+tail shape: a changed middle message still hits", async () => {
    const sc = await loadShadow();
    // 13 messages: first 4 head (full), 3 middle (roles only), last 6 tail (full).
    const long = {
      temperature: 0,
      messages: [
        { role: "system", content: "sys prompt" },
        { role: "user", content: "head message 1" },
        { role: "assistant", content: "head answer 1" },
        { role: "user", content: "head message 2" },
        { role: "assistant", content: "middle one" },
        { role: "user", content: "middle two" },
        { role: "assistant", content: "middle three" },
        { role: "user", content: "tail question" },
        { role: "assistant", content: "tail answer 1" },
        { role: "user", content: "tail followup" },
        { role: "assistant", content: "tail answer 2" },
        { role: "user", content: "tail final" },
        { role: "assistant", content: "tail closing" },
      ],
    };
    sc.storeShadow("test-model", long, response());
    // Same head/tail, different middle content → same shaped key → hit.
    const changed = JSON.parse(JSON.stringify(long));
    changed.messages[4].content = "middle one (edited)";
    expect(sc.lookupShadow("test-model", changed)).toEqual(response());
    // But a changed HEAD or TAIL message is a different request → miss.
    const changedTail = JSON.parse(JSON.stringify(long));
    changedTail.messages[7].content = "tail question (edited)";
    expect(sc.lookupShadow("test-model", changedTail)).toBeNull();
    const changedHead = JSON.parse(JSON.stringify(long));
    changedHead.messages[1].content = "head message 2 (edited)";
    expect(sc.lookupShadow("test-model", changedHead)).toBeNull();
  });
});

describe("shadowCache eligibility guards", () => {
  it("refuses non-zero temperature", async () => {
    const sc = await loadShadow();
    expect(sc.storeShadow("test-model", body({ temperature: 0.7 }), response())).toBe(false);
    expect(sc.lookupShadow("test-model", body({ temperature: 0.7 }))).toBeNull();
  });

  it("accepts temperature 0 and undefined, nothing else", async () => {
    const sc = await loadShadow();
    expect(sc.storeShadow("test-model", body({ temperature: 0 }), response())).toBe(true);
    expect(sc.storeShadow("test-model", { messages: [{ role: "user", content: "x" }] }, response())).toBe(true);
    expect(sc.storeShadow("test-model", body({ temperature: null }), response())).toBe(false);
    expect(sc.storeShadow("test-model", body({ temperature: 1 }), response())).toBe(false);
  });

  it("refuses streaming requests", async () => {
    const sc = await loadShadow();
    expect(sc.storeShadow("test-model", body({ stream: true }), response())).toBe(false);
    expect(sc.lookupShadow("test-model", body({ stream: true }))).toBeNull();
    // stream: false is still cacheable.
    expect(sc.storeShadow("test-model", body({ stream: false }), response())).toBe(true);
  });

  it("refuses requests carrying tools", async () => {
    const sc = await loadShadow();
    const withTools = body({ tools: [{ type: "function", function: { name: "get_time" } }] });
    expect(sc.storeShadow("test-model", withTools, response())).toBe(false);
    expect(sc.lookupShadow("test-model", withTools)).toBeNull();
    // An empty tools array is effectively "no tools" → cacheable.
    expect(sc.storeShadow("test-model", body({ tools: [] }), response())).toBe(true);
  });
});

describe("shadowCache bypass header", () => {
  it("honors x-shadow-cache: off on lookup and store", async () => {
    const sc = await loadShadow();
    const b = body();
    sc.storeShadow("test-model", b, response());
    // Fresh pass-through even though a shadow exists.
    expect(sc.lookupShadow("test-model", b, { headers: { "x-shadow-cache": "off" } })).toBeNull();
    expect(sc.shadowStats().bypasses).toBe(1);
    // Header can arrive mixed-case (raw Node-style headers object).
    expect(sc.lookupShadow("test-model", b, { headers: { "X-Shadow-Cache": "Off" } })).toBeNull();
    // And a bypass-marked request is never cached either.
    expect(sc.storeShadow("test-model", b, response("fresh"), { headers: { "x-shadow-cache": "off" } })).toBe(false);
    // Without the header the entry is still there.
    expect(sc.lookupShadow("test-model", b)).toEqual(response());
  });
});

describe("shadowCache LRU eviction + TTL", () => {
  it("evicts the least-recently-used entry beyond the 200 cap", async () => {
    const sc = await loadShadow();
    const make = (n) => body({ messages: [{ role: "user", content: `request number ${n}` }] });
    for (let i = 0; i < 201; i++) sc.storeShadow("test-model", make(i), response(`answer ${i}`));
    const s = sc.shadowStats();
    expect(s.entries).toBe(200);
    expect(s.evictions).toBeGreaterThanOrEqual(1);
    // Entry 0 was the oldest → gone; entry 200 survives.
    expect(sc.lookupShadow("test-model", make(0))).toBeNull();
    expect(sc.lookupShadow("test-model", make(200))).toEqual(response("answer 200"));
  });

  it("expires entries after the 6h TTL", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const sc = await loadShadow();
    const b = body();
    sc.storeShadow("test-model", b, response());
    expect(sc.lookupShadow("test-model", b)).toEqual(response());
    // Jump past the TTL — the shadow is gone.
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 1000);
    expect(sc.lookupShadow("test-model", b)).toBeNull();
    expect(sc.shadowStats().entries).toBe(0);
  });
});

describe("shadowCache encrypted persistence", () => {
  // Hook-backed store capturing every written blob (no disk involvement).
  function makeHook() {
    const state = { blob: null };
    const hook = ({ operation, data }) => {
      if (operation === "read") return state.blob;
      if (operation === "write") state.blob = data;
    };
    return { hook, state };
  }

  it("persists an encrypted blob that contains no plaintext", async () => {
    const sc = await loadShadow();
    const { hook, state } = makeHook();
    sc.setShadowCacheStore(hook);
    const secret = "the deploy script lives in scripts/deploy.sh";
    sc.storeShadow("test-model", body({ messages: [{ role: "user", content: secret }] }), response());

    expect(state.blob).toBeTruthy();
    expect(state.blob.startsWith("ORSHv1:")).toBe(true);
    // Raw blob must not leak the request or the response plaintext.
    expect(state.blob).not.toContain(secret);
    expect(state.blob).not.toContain("cached answer");
    expect(state.blob).not.toContain("chatcmpl-shadow");
  });

  it("round-trips through a store hook across module reloads", async () => {
    const { hook } = makeHook();
    const sc1 = await loadShadow();
    sc1.setShadowCacheStore(hook);
    const b = body({ messages: [{ role: "user", content: "persist me" }] });
    sc1.storeShadow("test-model", b, response("reloaded answer"));
    // The default file store must ALSO produce an encrypted-at-rest blob.
    const file = path.join(tempDir, "shadow-cache-v1.bin");
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      expect(raw.startsWith("ORSHv1:")).toBe(true);
      expect(raw).not.toContain("persist me");
    }

    // Fresh module (simulated restart) → same hook → hydration restores it.
    const sc2 = await loadShadow();
    sc2.setShadowCacheStore(hook);
    expect(sc2.lookupShadow("test-model", b)).toEqual(response("reloaded answer"));
  });

  it("treats corrupt or foreign blobs as a cold cache (fail-open)", async () => {
    const { hook } = makeHook();
    const sc = await loadShadow();
    // Poison the store, then hydrate — must not throw, must start empty.
    hook({ operation: "write", data: "not-our-blob" });
    sc.setShadowCacheStore(hook);
    expect(sc.lookupShadow("test-model", body())).toBeNull();
    expect(sc.shadowStats().decryptFailures).toBeGreaterThanOrEqual(1);
    // And the module still caches normally afterwards.
    expect(sc.storeShadow("test-model", body(), response())).toBe(true);
  });
});
