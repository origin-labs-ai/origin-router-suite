import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// The route reads the Cursor db with the sqlite3 CLI when better-sqlite3's
// native bindings are unavailable, so that is the strategy exercised here.
// The mock carries util.promisify's custom symbol so promisify(execFile)
// resolves { stdout, stderr } exactly like the real child_process.execFile.
const PROMISE_CUSTOM = Symbol.for("nodejs.util.promisify.custom");
vi.mock("child_process", () => {
  const execFile = vi.fn((file, args, options, cb) => {
    const sql = String(args?.[1] || "");
    let stdout = "";
    if (sql.includes("'cursorAuth/accessToken'")) stdout = process.env.__CURSOR_TOKEN || "";
    else if (sql.includes("'storage.serviceMachineId'")) stdout = process.env.__CURSOR_MACHINE_ID || "";
    cb(null, stdout, "");
  });
  execFile[PROMISE_CUSTOM] = (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (err, stdout, stderr) =>
        err ? reject(err) : resolve({ stdout, stderr }));
    });
  return { execFile };
});

// Shared mock db instance
const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

// Mock better-sqlite3 as a class so `new Database(...)` works
vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN");
      }
      return mockDbInstance;
    }
  },
}));

// We need to dynamically import after mocks are registered
let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    delete process.env.__CURSOR_TOKEN;
    delete process.env.__CURSOR_MACHINE_ID;
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("returns not-found when no macOS cursor db paths are accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    // The message lists the probed locations so the user can see where it looked.
    expect(response.body.error).toContain("state.vscdb");
  });

  it("probes both macOS locations before giving up", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    await GET();

    expect(fsPromises.access).toHaveBeenCalledTimes(2);
  });

  it("asks for a manual import when the db exists but no strategy can read it", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toContain("state.vscdb");
  });

  // ── Token extraction ──────────────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    process.env.__CURSOR_TOKEN = "test-token";
    process.env.__CURSOR_MACHINE_ID = "test-machine-id";

    const response = await GET();
    const { execFile } = await import("child_process");
    expect(execFile).toHaveBeenCalled();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    process.env.__CURSOR_TOKEN = '"json-token"';
    process.env.__CURSOR_MACHINE_ID = '"json-machine-id"';

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("asks for the known access-token and machine-id keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();

    await GET();

    const { execFile } = await import("child_process");
    const sql = execFile.mock.calls.map((call) => String(call[1]?.[1] || "")).join("\n");
    expect(sql).toContain("'cursorAuth/accessToken'");
    expect(sql).toContain("'storage.serviceMachineId'");
  });

  it("returns the manual-import prompt when tokens are missing even after the fallback", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── Backwards-compatible: linux/win32 keep the single-path logic ──────

  it("linux skips auto-import when the Cursor IDE is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });

  it("unsupported platform falls back to the default locations", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });
});
