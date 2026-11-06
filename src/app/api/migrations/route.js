import { NextResponse } from "next/server";
import { listSources, runMigration } from "@/lib/migrations/sources";
import { getSettings, updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET - what can be imported from this machine, and whether the wizard has
// already run.
export async function GET() {
  try {
    const settings = await getSettings();
    const { sources } = await listSources();
    return NextResponse.json({
      onboarded: settings?.onboardingComplete === true || settings?.onboardingComplete === "true",
      sources,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST - run one import, or skip the wizard entirely.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sourceId = body?.sourceId;

    let result = { ok: true, imported: [], skipped: [], source: null };
    if (sourceId && sourceId !== "scratch") {
      result = await runMigration(sourceId);
      if (!result.ok) {
        return NextResponse.json(result, { status: 400 });
      }
    }

    await updateSettings({
      onboardingComplete: true,
      onboardingSource: sourceId || "scratch",
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
