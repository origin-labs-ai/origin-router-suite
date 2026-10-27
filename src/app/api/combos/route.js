import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { findSeatsBelowContext, describeContextShort } from "@/lib/comboContext";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const combos = await getCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind, maxContextWindow, displayName } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    // Check if name already exists
    const existing = await getComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    // A context ceiling is a promise: every member must be able to serve it.
    if (maxContextWindow) {
      const combosByName = new Map((await getCombos()).map((c) => [c.name, c]));
      const offenders = findSeatsBelowContext(models || [], maxContextWindow, combosByName);
      if (offenders.length > 0) {
        return NextResponse.json({
          error: `These models cannot serve ${maxContextWindow} tokens of context: ${describeContextShort(offenders)}`,
          contextViolations: offenders,
        }, { status: 400 });
      }
    }

    const combo = await createCombo({
      name,
      models: models || [],
      kind: kind || null,
      maxContextWindow: maxContextWindow || null,
      displayName: displayName || null,
    });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
