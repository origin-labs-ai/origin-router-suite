import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { isDeclaredContextWindow, MAX_CONTEXT_WINDOW } from "@/lib/contextLimits";
import { declaredContextWindow } from "@/lib/comboContext";
import { applyContextCeilings } from "@/lib/contextCeilings";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();
    // Owner-declared ceilings (~/.or/context-ceilings.json) win over the name
    // heuristic, and `contextDeclared` tells the UI the difference so a guess is
    // never shown as if it were the model's hardware limit.
    applyContextCeilings();
    const windowFor = (alias, providerId, model, rowValue) => {
      // Only real declarations count: the owner's ceiling file, the provider's
      // static registry record, or a window stored on the model row itself.
      //
      // The capability table's family patterns (a name containing "deepseek"
      // reading as 128K, "omni" as 262K) are NOT declarations: they are guesses,
      // and counting them re-created the "cannot serve 1M" list every time a new
      // seat was picked. Unknown is reported as null, which renders no badge.
      const declared = declaredContextWindow(alias, model) ?? declaredContextWindow(providerId, model);
      if (declared != null) {
        return { contextWindow: Math.min(declared, MAX_CONTEXT_WINDOW), contextDeclared: true, contextSource: "declared-ceiling" };
      }
      if (isDeclaredContextWindow(rowValue)) {
        return { contextWindow: Math.min(rowValue, MAX_CONTEXT_WINDOW), contextDeclared: true, contextSource: "model-record" };
      }
      return { contextWindow: null, contextDeclared: false, contextSource: "undeclared" };
    };

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        // Static catalog rows have no per-row record; their registry entry is
        // already consulted inside windowFor via the provider id.
        const win = windowFor(m.provider, m.provider, m.model, undefined);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: win.contextWindow,
            contextDeclared: win.contextDeclared,
            maxOutput: c.maxOutput,
          },
        };
      });

    // Custom models ride along; their stored caps override the name heuristic.
    // A custom row whose provider alias routes to an already-listed model is a
    // pure shadow: the real entry wins (and is listed first), but this row would
    // land later with the same routedModel key and the client's last-write-wins
    // map then serves its thinner caps (a pre-registry "add custom model" row
    // stores {vision, reasoning} only — no contextWindow). Drop the shadow and
    // resolve the survivors' provider id, not the UI alias: the capability
    // tables are keyed by provider id, and an alias like `ocg` misses the
    // provider-scoped entries and falls back to the generic patterns.
    const seenFull = new Set(models.map((m) => m.fullModel));
    const seenRouted = new Set(models.map((m) => m.routedModel));
    const customModels = (await getCustomModels()).filter((m) => {
      if (!m?.id || (m.kind || m.type || "llm") !== "llm") return false;
      if (seenRouted.has(`${m.providerAlias}/${m.id}`)) return false;
      return !seenFull.has(`${m.providerAlias}/${m.id}`);
    });
    for (const m of customModels) {
      const fullModel = `${m.providerAlias}/${m.id}`;
      const providerId = ALIAS_TO_ID[m.providerAlias] || m.providerAlias;
      const c = getCapabilitiesForModel(providerId, m.id);
      // Only the row's own stored number is a declaration here; falling back to
      // c.contextWindow would smuggle the family-pattern guess back in.
      const win = windowFor(m.providerAlias, providerId, m.id, m.caps?.contextWindow);
      models.push({
        provider: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          maxOutput: c.maxOutput,
          ...(m.caps || {}),
          contextWindow: win.contextWindow,
          contextDeclared: win.contextDeclared,
        },
      });
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
