import { PROVIDER_MODELS } from "@/shared/constants/models";
import { getCombos, getSettings } from "@/lib/localDb";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET() {
  try {
    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"], inputTokenLimit = 128000 }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit,
        outputTokenLimit: 8192,
      });
    }

    // Combos-only mode (Settings → Combos): the Gemini surface publishes the
    // combo ids and nothing else, matching /v1/models.
    let settings = {};
    try { settings = await getSettings(); } catch { /* defaults */ }

    if (settings?.exposeAllModels !== true) {
      let combos = [];
      try { combos = await getCombos(); } catch { /* no db */ }
      for (const combo of combos) {
        if (combo?.kind && combo.kind !== "llm") continue;
        addModel({
          name: `models/${combo.name}`,
          displayName: combo.name,
          description: `OriginRouter combo: ${combo.name}`,
          methods: ["generateContent", "streamGenerateContent"],
          inputTokenLimit: Number(combo.maxContextWindow) > 0 ? Number(combo.maxContextWindow) : 128000,
        });
      }
      return Response.json({ models });
    }

    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
        });

        if (provider === "gemini") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
          });
        }
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
