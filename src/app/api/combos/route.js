import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { findSeatsBelowContext } from "@/lib/comboContext";
import { applyContextCeilings } from "@/lib/contextCeilings";

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

    // A context ceiling is a promise, so report who cannot keep it — as advice.
    // Refusing the save would punish the owner for numbers most of these seats
    // never declared; at runtime an oversized request simply rotates past a member
    // that cannot take it, which is what the failover layer is for.
    let contextWarnings = [];
    if (maxContextWindow) {
      // Owner-declared ceilings (~/.or/context-ceilings.json) count as evidence.
      applyContextCeilings();
      const combosByName = new Map((await getCombos()).map((c) => [c.name, c]));
      contextWarnings = findSeatsBelowContext(models || [], maxContextWindow, combosByName);
    }

    const combo = await createCombo({
      name,
      models: models || [],
      kind: kind || null,
      maxContextWindow: maxContextWindow || null,
      displayName: displayName || null,
    });

    return NextResponse.json(
      contextWarnings.length ? { ...combo, contextWarnings } : combo,
      { status: 201 },
    );
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
