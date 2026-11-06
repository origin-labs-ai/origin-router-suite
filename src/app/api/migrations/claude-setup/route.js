import { NextResponse } from "next/server";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getModelAliases } from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import {
  applyClaudeSetup,
  claudeSettingsPath,
  detectClaudeCode,
  normalizeBaseUrl,
  readClaudeSettings,
  removeClaudeSetup,
} from "@/lib/claudeCodeSetup";

export const dynamic = "force-dynamic";

const CLAUDE = CLI_TOOLS.claude;

// The model picker is what Claude Code shows when the user asks for a model.
// The descriptions are the ones Claude Code itself uses.
const MODEL_DESCRIPTIONS = {
  fable: "Most capable model for complex tasks",
  opus: "Powerful model for hard problems",
  sonnet: "Balanced speed and capability",
  haiku: "Fast and efficient for everyday tasks",
};

function modelOption(model, value) {
  return {
    model: value,
    label: model.name,
    description: MODEL_DESCRIPTIONS[model.alias] || `${model.name} through OriginRouter`,
  };
}

// The dashboard and the router are the same process, so the endpoint Claude
// Code should call is the host the browser is talking to.
function requestOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// Claude Code needs a key to present. If the router has none yet, the native
// setup creates one - that is the whole point of doing it here instead of
// asking the user to paste a key into a file.
async function resolveApiKey(preferred) {
  const wanted = typeof preferred === "string" ? preferred.trim() : "";
  if (wanted) return { key: wanted, name: "selected", created: false };

  const keys = await getApiKeys();
  const active = keys.find((key) => key.isActive !== false) || keys[0];
  if (active) return { key: active.key, name: active.name, created: false };

  const machineId = await getConsistentMachineId();
  const created = await createApiKey("Claude Code", machineId);
  return { key: created.key, name: created.name, created: true };
}

// GET - what a native setup would write, and what is on disk right now.
export async function GET(request) {
  try {
    const installed = await detectClaudeCode();
    const settings = await readClaudeSettings();
    const keys = await getApiKeys();
    const aliases = await getModelAliases();
    const active = keys.find((key) => key.isActive !== false) || keys[0];

    return NextResponse.json({
      installed,
      settingsPath: claudeSettingsPath(),
      configured: !!settings?.env?.ANTHROPIC_BASE_URL,
      currentBaseUrl: settings?.env?.ANTHROPIC_BASE_URL || "",
      hasToken: !!settings?.env?.ANTHROPIC_AUTH_TOKEN,
      suggestedBaseUrl: normalizeBaseUrl(requestOrigin(request)),
      apiKey: active?.key || "",
      apiKeyName: active?.name || "",
      models: CLAUDE.defaultModels.map((model) => ({
        alias: model.alias,
        name: model.name,
        envKey: model.envKey,
        model: aliases[model.alias] || model.defaultValue || "",
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST - point Claude Code at this router.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const baseUrl = normalizeBaseUrl(body?.baseUrl || requestOrigin(request));
    if (!baseUrl) {
      return NextResponse.json({ error: "No endpoint to write" }, { status: 400 });
    }

    const resolved = await resolveApiKey(body?.apiKey);
    const aliases = await getModelAliases();

    // The models are keyed by alias in the request, by env key on disk.
    const requested = body?.models && typeof body.models === "object" ? body.models : {};
    const modelMappings = {};
    const modelOptions = [];
    for (const model of CLAUDE.defaultModels) {
      const value = requested[model.alias] || aliases[model.alias] || model.defaultValue || "";
      if (!value) continue;
      modelMappings[model.envKey] = value;
      modelOptions.push(modelOption(model, value));
    }
    // The small and fast model is what Claude Code uses for the short tasks.
    if (modelMappings.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
      modelMappings.ANTHROPIC_SMALL_FAST_MODEL = modelMappings.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    }

    const result = await applyClaudeSetup({
      baseUrl,
      apiKey: resolved.key,
      modelMappings,
      modelOptions,
      autoCompactWindow: body?.autoCompactWindow || "",
      backup: true,
    });

    return NextResponse.json({
      ...result,
      createdKey: resolved.created,
      apiKeyName: resolved.name,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE - hand Claude Code back to Anthropic.
export async function DELETE() {
  try {
    const result = await removeClaudeSetup();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
