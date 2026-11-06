// Native Claude Code setup.
//
// Claude Code keeps its whole configuration in ~/.claude/settings.json. This
// module is the single place that knows where that file lives, how to read it
// (Claude Code allows JSONC there) and what has to be inside it for Claude
// Code to talk to OriginRouter instead of Anthropic.
//
// The CLI tools page and the first-run wizard both use this, so the file is
// written the same way no matter which door the user comes in through.

import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Claude Code's own request budget. The router keeps a turn open while it
// walks providers, so the client must not time out first (2h, matching the
// router's stream stall/first-token limits).
export const CLAUDE_TIMEOUT_MS = "7200000";

// The answer budget Claude Code may use for one reply, and how hard it tries
// on a hard turn.
export const CLAUDE_MAX_OUTPUT_TOKENS = "32000";
export const CLAUDE_EFFORT_LEVEL = "xhigh";
export const CLAUDE_AUTO_UPDATE_CHANNEL = "latest";

export const CLAUDE_TIMEOUT_KEYS = [
  "API_TIMEOUT_MS",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
];

// Everything that points Claude Code at a router. Removing these hands Claude
// Code back to Anthropic.
export const ORIGINROUTER_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  ...CLAUDE_TIMEOUT_KEYS,
];

export function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// The previous file is kept next to it, so a native setup can always be
// undone by hand.
export function claudeBackupPath() {
  return path.join(os.homedir(), ".claude", "settings.json.originrouter-backup.json");
}

// Claude Code CLI reads mcpServers from ~/.claude.json, not from settings.json.
export function claudeJsonPath() {
  return path.join(os.homedir(), ".claude.json");
}

// Claude Code accepts JSONC in settings.json, so a trailing comma must not
// read as "no configuration".
export function parseJsonc(content) {
  try {
    return JSON.parse(String(content).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

export async function readClaudeSettings() {
  try {
    return parseJsonc(await fs.readFile(claudeSettingsPath(), "utf-8"));
  } catch {
    return null;
  }
}

export async function writeClaudeSettings(settings) {
  const filePath = claudeSettingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  return filePath;
}

export async function backupClaudeSettings() {
  try {
    const content = await fs.readFile(claudeSettingsPath(), "utf-8");
    await fs.writeFile(claudeBackupPath(), content);
    return true;
  } catch {
    return false;
  }
}

// Is the Claude Code CLI on this machine? Either the binary is there, or a
// settings file was written before (a user can uninstall the CLI and keep
// the config).
export async function detectClaudeCode() {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(claudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
}

export function normalizeBaseUrl(url) {
  if (!url) return "";
  const trimmed = String(url).trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// Builds the env block Claude Code needs. Model mappings are keyed by the env
// key they belong to (ANTHROPIC_DEFAULT_OPUS_MODEL and friends).
export function buildClaudeEnv({
  baseUrl,
  apiKey,
  modelMappings = {},
  autoCompactWindow,
  existingEnv = {},
}) {
  const env = {};
  const url = normalizeBaseUrl(baseUrl);
  if (url) env.ANTHROPIC_BASE_URL = url;
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  for (const [key, value] of Object.entries(modelMappings)) {
    if (key && value) env[key] = value;
  }
  if (autoCompactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = CLAUDE_MAX_OUTPUT_TOKENS;
  for (const key of CLAUDE_TIMEOUT_KEYS) {
    if (!env[key] && !existingEnv[key]) env[key] = CLAUDE_TIMEOUT_MS;
  }
  return env;
}

// Writes the settings file, keeping everything that was already in it.
//
// The result is the shape Claude Code understands end to end: the endpoint
// and the key in `env`, the models it may offer in `modelPicker`, the effort
// level for a hard turn in `effortLevel` and `modelSettings`.
export async function applyClaudeSetup({
  baseUrl,
  apiKey,
  modelMappings = {},
  modelOptions = [],
  autoCompactWindow,
  effortLevel = CLAUDE_EFFORT_LEVEL,
  backup = false,
}) {
  const current = (await readClaudeSettings()) || {};
  if (backup) await backupClaudeSettings();
  const env = buildClaudeEnv({
    baseUrl,
    apiKey,
    modelMappings,
    autoCompactWindow,
    existingEnv: current.env || {},
  });
  const settings = {
    ...current,
    hasCompletedOnboarding: true,
    env: {
      ...(current.env || {}),
      ...env,
    },
  };

  if (Array.isArray(modelOptions) && modelOptions.length) {
    settings.modelPicker = {
      options: modelOptions,
      replaceBuiltInOptions: true,
    };
  }

  if (effortLevel) {
    settings.effortLevel = effortLevel;
    settings.modelSettings = { ...(current.modelSettings || {}) };
    for (const option of modelOptions || []) {
      if (!option?.model) continue;
      settings.modelSettings[option.model] = {
        ...(settings.modelSettings[option.model] || {}),
        effortLevel,
      };
    }
  }

  if (!current.autoUpdatesChannel) {
    settings.autoUpdatesChannel = CLAUDE_AUTO_UPDATE_CHANNEL;
  }

  const settingsPath = await writeClaudeSettings(settings);
  return { ok: true, settingsPath, env, settings };
}

// Hands Claude Code back to Anthropic by removing the router's keys.
export async function removeClaudeSetup() {
  const current = await readClaudeSettings();
  const settingsPath = claudeSettingsPath();
  if (!current) return { ok: true, settingsPath, removed: [] };
  const removed = [];
  if (current.env) {
    for (const key of ORIGINROUTER_ENV_KEYS) {
      if (current.env[key]) removed.push(key);
      delete current.env[key];
    }
    if (Object.keys(current.env).length === 0) delete current.env;
  }
  await writeClaudeSettings(current);
  return { ok: true, settingsPath, removed };
}
