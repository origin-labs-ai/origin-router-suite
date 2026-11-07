// OpenCode CLI migration source tests — detection, keyless filtering, and
// the Key-2 dedup rule. detectOpenCode reads os.homedir() at call time, so
// HOME is faked per call. Fixture keys deliberately avoid real credential
// shapes: they are obviously-fake strings, never secrets.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "or-opencode-test-"));
const originalHome = process.env.USERPROFILE;
const originalHomeB = process.env.HOME;

const FIXTURE_KEY_ONE = "fixture-key-one-not-a-secret";
const FIXTURE_KEY_TWO = "fixture-key-two-not-a-secret";

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
        deepseek: { name: "DeepSeek", options: { baseURL: "https://api.deepseek.com", apiKey: FIXTURE_KEY_ONE }, models: { "deepseek-v4": {} } },
        nexapi: { name: "NexAPI", options: { baseURL: "https://api.nexapi.example/v1", apiKey: FIXTURE_KEY_TWO } },
      },
    });
    process.env.USERPROFILE = TMP;
    process.env.HOME = TMP;
    const sources = await import("../../src/lib/migrations/sources.js");
    const { candidates } = await sources.listSources();
    expect(candidates.openCode).toBeTruthy();
    expect(candidates.openCode.providers).toHaveLength(2);
    const ds = candidates.openCode.providers.find((p) => p.id === "deepseek");
    expect(ds.apiKey).toBe(FIXTURE_KEY_ONE);
    expect(ds.modelCount).toBe(1);
    expect(ds.baseUrl).toBe("https://api.deepseek.com");
  });

  it("skips provider entries without an api key (OAuth grants never migrate)", async () => {
    writeConfig({
      provider: {
        oauthOnly: { name: "Nope", options: { baseURL: "https://x.example" } },
        keyed: { name: "Yes", options: { baseURL: "https://y.example/v1", apiKey: FIXTURE_KEY_ONE } },
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

describe("Key-2 dedup rule (createConnectionWithKeyDedup)", () => {
  const load = async () => import("../../src/lib/migrations/sources.js");

  it("a second key imports as '<label> Key 2', a third as 'Key 3'", async () => {
    const sources = await load();
    const names = [];
    const fakeCreate = async (spec) => {
      // The plain name and the "Key 2" slot are already taken by the older
      // connections — the third import must land on "Key 3".
      if (spec.name === "NVIDIA" || spec.name === "NVIDIA Key 2") {
        const err = new Error("name conflict");
        err.code = "PROVIDER_NAME_CONFLICT";
        throw err;
      }
      names.push(spec.name);
      return { id: `conn-${names.length}`, name: spec.name };
    };
    const res = await sources.createConnectionWithKeyDedup(fakeCreate, {
      provider: "nvidia",
      label: "NVIDIA",
      apiKey: FIXTURE_KEY_TWO,
    });
    expect(res.name).toBe("NVIDIA Key 3");
    expect(names).toEqual(["NVIDIA Key 3"]);
  });

  it("no conflict means the original name wins untouched", async () => {
    const sources = await load();
    const fakeCreate = async (spec) => ({ id: "conn-1", name: spec.name });
    const res = await sources.createConnectionWithKeyDedup(fakeCreate, {
      provider: "deepseek",
      label: "DeepSeek",
      apiKey: FIXTURE_KEY_ONE,
    });
    expect(res.name).toBe("DeepSeek");
  });

  it("non-conflict errors propagate (never swallowed)", async () => {
    const sources = await load();
    const boom = async () => {
      throw new Error("db down");
    };
    await expect(
      sources.createConnectionWithKeyDedup(boom, { provider: "x", label: "X", apiKey: FIXTURE_KEY_ONE }),
    ).rejects.toThrow(/db down/);
  });
});
