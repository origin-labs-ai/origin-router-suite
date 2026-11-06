// The native Claude Code setup writes ~/.claude/settings.json. Getting that
// file wrong would point Claude Code at the wrong endpoint, so the pure parts
// (parsing, URL normalisation, the env block) and the file handling are
// tested against a fake home.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyClaudeSetup,
  buildClaudeEnv,
  claudeBackupPath,
  claudeSettingsPath,
  normalizeBaseUrl,
  parseJsonc,
  removeClaudeSetup,
  CLAUDE_TIMEOUT_MS,
} from "../../src/lib/claudeCodeSetup.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-claude-"));
const fakeHome = path.join(tmpRoot, "home");
fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

describe("claude code setup", () => {
  beforeEach(() => {
    // os.homedir() reads these on every call, so the module picks the fake
    // home up without being re-imported.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    fs.rmSync(claudeSettingsPath(), { force: true });
    fs.rmSync(claudeBackupPath(), { force: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  });

  it("reads a settings file that has a trailing comma", () => {
    expect(parseJsonc('{"env":{"A":"1"},}')).toEqual({ env: { A: "1" } });
    expect(parseJsonc("not json")).toBeNull();
  });

  it("adds the /v1 suffix exactly once", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:20128")).toBe("http://127.0.0.1:20128/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:20128/v1")).toBe("http://127.0.0.1:20128/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:20128/")).toBe("http://127.0.0.1:20128/v1");
    expect(normalizeBaseUrl("")).toBe("");
  });

  it("builds the env block Claude Code needs", () => {
    const env = buildClaudeEnv({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_test",
      modelMappings: { ANTHROPIC_DEFAULT_OPUS_MODEL: "openai/gpt-5" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk_test");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("openai/gpt-5");
    expect(env.API_TIMEOUT_MS).toBe(CLAUDE_TIMEOUT_MS);
  });

  it("keeps a timeout the user already set", () => {
    const env = buildClaudeEnv({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_test",
      existingEnv: { API_TIMEOUT_MS: "60000" },
    });
    expect(env.API_TIMEOUT_MS).toBeUndefined();
  });

  it("writes the settings file and keeps what was already there", async () => {
    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({ env: { KEEP_ME: "yes" }, theme: "dark" }, null, 2)
    );

    const result = await applyClaudeSetup({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_test",
      modelMappings: { ANTHROPIC_DEFAULT_SONNET_MODEL: "openai/gpt-5" },
    });

    expect(result.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("sk_test");
    expect(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("openai/gpt-5");
    expect(written.env.KEEP_ME).toBe("yes");
    expect(written.theme).toBe("dark");
    expect(written.hasCompletedOnboarding).toBe(true);
  });

  it("backs up the previous file before overwriting it", async () => {
    fs.writeFileSync(claudeSettingsPath(), JSON.stringify({ theme: "dark" }));
    await applyClaudeSetup({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk_test", backup: true });
    const backup = JSON.parse(fs.readFileSync(claudeBackupPath(), "utf-8"));
    expect(backup.theme).toBe("dark");
  });

  it("writes the whole shape Claude Code understands", async () => {
    const { applyClaudeSetup, claudeSettingsPath, CLAUDE_EFFORT_LEVEL } = await import(
      "../../src/lib/claudeCodeSetup.js"
    );
    await applyClaudeSetup({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_test",
      modelMappings: { ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-5" },
      modelOptions: [
        { model: "cc/claude-opus-5", label: "Claude Opus", description: "Powerful model" },
      ],
    });

    const written = JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf-8"));
    expect(written.modelPicker.replaceBuiltInOptions).toBe(true);
    expect(written.modelPicker.options[0].model).toBe("cc/claude-opus-5");
    expect(written.effortLevel).toBe(CLAUDE_EFFORT_LEVEL);
    expect(written.modelSettings["cc/claude-opus-5"].effortLevel).toBe(CLAUDE_EFFORT_LEVEL);
    expect(written.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
    expect(written.autoUpdatesChannel).toBe("latest");
  });

  it("hands Claude Code back to Anthropic on reset", async () => {    await applyClaudeSetup({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_test",
      modelMappings: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "openai/gpt-5" },
    });

    const result = await removeClaudeSetup();
    expect(result.ok).toBe(true);
    expect(result.removed).toContain("ANTHROPIC_BASE_URL");
    expect(result.removed).toContain("ANTHROPIC_AUTH_TOKEN");

    const written = JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf-8"));
    expect(written.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(written.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(written.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });
});
