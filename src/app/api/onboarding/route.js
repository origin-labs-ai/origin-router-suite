import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DATA_DIR, readDataLocationPreference, writeDataLocationPreference } from "@/lib/dataDir";
import { isPortableInstall } from "@/lib/installMode";
import {
  createApiKey,
  createCombo,
  getApiKeys,
  getCombos,
  getSettings,
  updateSettings,
} from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { presetComboStrategy, presetSettingsPatch } from "@/lib/onboardingPresets";
import { listSources } from "@/lib/migrations/sources";

export const dynamic = "force-dynamic";

const TRAY_PREFERENCE_FILE = path.join(os.homedir(), ".or", "tray-preference.json");

async function readTrayPreference() {
  try {
    const parsed = JSON.parse(await fs.readFile(TRAY_PREFERENCE_FILE, "utf-8"));
    if (typeof parsed?.tray === "boolean") return parsed.tray;
  } catch {
    // No answer stored yet.
  }
  return null;
}

async function writeTrayPreference(tray) {
  await fs.mkdir(path.dirname(TRAY_PREFERENCE_FILE), { recursive: true });
  await fs.writeFile(TRAY_PREFERENCE_FILE, `${JSON.stringify({ tray }, null, 2)}\n`, "utf-8");
  return TRAY_PREFERENCE_FILE;
}

// GET - everything the wizard needs to draw itself.
export async function GET() {
  try {
    const [sourcesResult, keys] = await Promise.all([
      listSources().catch(() => ({ sources: [] })),
      getApiKeys(),
    ]);

    return NextResponse.json({
      portable: isPortableInstall(),
      dataDir: DATA_DIR,
      dataDirPreference: readDataLocationPreference(),
      defaultDataDir: path.join(os.homedir(), ".or"),
      trayPreference: await readTrayPreference(),
      sources: sourcesResult.sources || [],
      apiKeys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        key: key.key,
        isActive: key.isActive,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST - the actions the wizard performs.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    if (action === "dataLocation") {
      const dir = String(body?.dir || "").trim();
      if (!dir) {
        return NextResponse.json({ error: "A folder is required" }, { status: 400 });
      }
      // The folder has to be usable before it is remembered.
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir);
      writeDataLocationPreference(dir);
      return NextResponse.json({ ok: true, dataDir: dir, restartRequired: true });
    }

    if (action === "trayPreference") {
      const tray = body?.tray === true;
      const file = await writeTrayPreference(tray);
      return NextResponse.json({ ok: true, tray, file });
    }

    if (action === "apiKey") {
      const machineId = await getConsistentMachineId();
      const apiKey = await createApiKey(String(body?.name || "OriginRouter"), machineId);
      return NextResponse.json({ ok: true, apiKey });
    }

    if (action === "settings") {
      const patch = body?.patch || {};
      const settings = (await getSettings()) || {};
      const next = { ...settings };
      for (const [key, value] of Object.entries(patch)) {
        next[key] =
          value && typeof value === "object" && !Array.isArray(value)
            ? { ...(settings[key] || {}), ...value }
            : value;
      }
      await updateSettings(next);
      return NextResponse.json({ ok: true });
    }

    if (action === "combo") {
      const name = String(body?.name || "").trim();
      if (!name) {
        return NextResponse.json({ error: "The combo needs a name" }, { status: 400 });
      }
      const models = Array.isArray(body?.models) ? body.models.filter(Boolean) : [];

      const existing = await getCombos();
      let combo = existing.find((entry) => entry.name === name);
      if (!combo) {
        combo = await createCombo({ name, models, displayName: name });
      }

      // The preset writes the global routing and the per-combo strategy.
      const patch = presetSettingsPatch(body?.presetId);
      const strategy = presetComboStrategy(body?.presetId) || body?.strategy || null;
      const settings = (await getSettings()) || {};

      if (Object.keys(patch).length) {
        const next = { ...settings };
        for (const [key, value] of Object.entries(patch)) {
          next[key] =
            value && typeof value === "object" && !Array.isArray(value)
              ? { ...(settings[key] || {}), ...value }
              : value;
        }
        await updateSettings(next);
      }

      if (strategy) {
        await updateSettings({
          comboStrategies: {
            ...(settings.comboStrategies || {}),
            [name]: {
              ...(settings.comboStrategies?.[name] || {}),
              ...strategy,
            },
          },
        });
      }

      return NextResponse.json({ ok: true, combo });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
