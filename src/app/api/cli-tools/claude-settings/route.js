"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";
import {
  claudeSettingsPath,
  detectClaudeCode,
  normalizeBaseUrl,
  readClaudeSettings,
  restoreClaudeDefaults,
} from "@/lib/claudeCodeSetup";

// Exa MCP def — reuse from coworkPlugins (DRY).
const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa");
const buildExaMcpEntry = () => ({
  type: EXA_PLUGIN.transport,
  url: EXA_PLUGIN.url,
});

// Claude Code CLI reads mcpServers from ~/.claude.json (NOT settings.json).
const getClaudeJsonPath = () => path.join(os.homedir(), ".claude.json");

const readClaudeJson = async () => {
  try {
    const content = await fs.readFile(getClaudeJsonPath(), "utf-8");
    return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

const writeClaudeJsonMcp = async (mcpServers) => {
  const filePath = getClaudeJsonPath();
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    data.mcpServers = { ...(data.mcpServers || {}), ...mcpServers };
  } else if (data.mcpServers) {
    delete data.mcpServers.exa;
    if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
};


// Read current settings
const readSettings = readClaudeSettings;

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await detectClaudeCode();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const hasOriginRouter = !!(settings?.env?.ANTHROPIC_BASE_URL);
    const claudeJson = await readClaudeJson();

    return NextResponse.json({
      installed: true,
      settings: settings,
      hasOriginRouter: hasOriginRouter,
      exaMcpEnabled: !!claudeJson?.mcpServers?.exa,
      settingsPath: claudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json(
      { error: "Failed to check claude settings" },
      { status: 500 }
    );
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const body = await request.json();

    // Action branch: POST { action: "restore-default" } hands Claude Code its
    // previous configuration back. The backup written next to the live file is
    // restored when one exists; without one, only the keys this route and the
    // native setup manage are removed and the rest of the user's file is left
    // exactly as it was (see restoreClaudeDefaults in claudeCodeSetup.js).
    if (body?.action === "restore-default") {
      return NextResponse.json(await restoreClaudeDefaults());
    }

    const { env, exaMcpEnabled, autoCompactWindow } = body;

    if (!env || typeof env !== "object") {
      return NextResponse.json(
        { error: "Invalid env object" },
        { status: 400 }
      );
    }

    const settingsPath = claudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = normalizeBaseUrl(env.ANTHROPIC_BASE_URL);
    }

    // Keep an existing token (real key or earlier config); only add when absent — Reset clears it.
    if (currentSettings.env?.ANTHROPIC_AUTH_TOKEN) {
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    // Claude Code's own request budget. The router keeps a turn open while it
    // walks providers, so the client must not time out first (2h, matching the
    // router's stream stall/first-token limits). Every other timeout knob gets
    // the same ceiling so no long command, MCP call or tool run dies early.
    const CLAUDE_TIMEOUT_MS = "7200000";
    const timeoutKeys = [
      "API_TIMEOUT_MS",
      "BASH_DEFAULT_TIMEOUT_MS",
      "BASH_MAX_TIMEOUT_MS",
      "MCP_TIMEOUT",
      "MCP_TOOL_TIMEOUT",
    ];
    for (const key of timeoutKeys) {
      if (!env[key] && !currentSettings.env?.[key]) env[key] = CLAUDE_TIMEOUT_MS;
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };

    // CLAUDE_CODE_AUTO_COMPACT_WINDOW — the token threshold that triggers
    // auto-compact. Only set when a concrete value is chosen; "Default" removes
    // the key so Claude Code derives the window from the model.
    if (autoCompactWindow) {
      newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
    } else {
      delete newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    // Write new settings
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));

    // Exa MCP toggle — write to ~/.claude.json (CLI reads mcpServers from here).
    if (EXA_PLUGIN) {
      await writeClaudeJsonMcp(exaMcpEnabled ? { exa: buildExaMcpEntry() } : null);
    }

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json(
      { error: "Failed to update claude settings" },
      { status: 500 }
    );
  }
}

// Fields to remove when resetting
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = claudeSettingsPath();

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });
      
      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }

    // Remove injected MCP servers (Exa) from ~/.claude.json
    await writeClaudeJsonMcp(null);

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    return NextResponse.json(
      { error: "Failed to reset claude settings" },
      { status: 500 }
    );
  }
}
