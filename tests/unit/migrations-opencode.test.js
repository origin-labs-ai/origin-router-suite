// OpenCode CLI migration source tests — detection + keyless-entry filtering.
// detectOpenCode reads os.homedir() at call time, so HOME is faked per call.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "or-opencode-test-"));
const originalHome = process.env.USERPROFILE;
const originalHomeB = process.env.HOME;

function writeConfig(config) {
  const dir = path.join(TMP, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(config));
}

afterEach(() => {
  process.env.USERPROFILE = originalHome;
  process.env.HOME = originalHomeB;
});

describe("opencode migration source", () => {
  it("detects providers with api keys from opencode.json", async () => {
    writeConfig({
      $schema: "https://opencode.ai/config.json",
      provider: {
        deepseek: { name: "DeepSeek", options: { baseURL: "https://api.deepseek.com", apiKey: "sk-test-deepseek-123" }, models: { "deepseek-v4": {} } },
        nexapi: { name: "NexAPI", options: { baseURL: "https://api.nexapi.example/v1", apiKey: "sk-nex-456" } },
      },
    });
    process.env.USERPROFILE = TMP;
    process.env.HOME = TMP;
    const sources = await import("../../src/lib/migrations/sources.js");
    const { candidates } = await sources.listSources();
    expect(candidates.openCode).toBeTruthy();
    expect(candidates.openCode.providers).toHaveLength(2);
    const ds = candidates.openCode.providers.find((p) => p.id === "deepseek");
    expect(ds.apiKey).toBe("sk-test-deepseek-123");
    expect(ds.modelCount).toBe(1);
    expect(ds.baseUrl).toBe("https://api.deepseek.com");
  });

  it("skips provider entries without an api key (OAuth grants never migrate)", async () => {
    writeConfig({
      provider: {
        oauthOnly: { name: "Nope", options: { baseURL: "https://x.example" } },
        keyed: { name: "Yes", options: { baseURL: "https://y.example/v1", apiKey: "sk-yes" } },
      },
    });
    process.env.USERPROFILE = TMP;
    process.env.HOME = TMP;
    const sources = await import("../../src/lib/migrations/sources.js");
    const { candidates } = await sources.listSources();
    expect(candidates.openCode).toBeTruthy();
    expect(candidates.openCode.providers.map((p) => p.id)).toEqual(["keyed"]);
  });
});
