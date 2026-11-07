import { NextResponse } from "next/server";
import { listScopes, stats, rememberText, recallText, forgetText } from "@/lib/memoryFabric";

export const dynamic = "force-dynamic";

// GET /api/memory-fabric - Scope list + counters, or a scoped recall when
// ?scope= is present (optional ?query= substring, ?limit= page size).
// Auth is enforced by the global dashboard guard (same as /api/combos).
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope");
    if (scope) {
      const memories = await recallText(scope, {
        limit: searchParams.get("limit") || undefined,
        query: searchParams.get("query") || "",
      });
      return NextResponse.json({ memories });
    }
    const [scopes, fabricStats] = await Promise.all([listScopes(), stats()]);
    return NextResponse.json({ scopes, stats: fabricStats });
  } catch (error) {
    console.log("Error fetching memory fabric:", error);
    return NextResponse.json({ error: "Failed to fetch memory fabric" }, { status: 500 });
  }
}

// POST /api/memory-fabric - Remember { scope, content, source }
export async function POST(request) {
  try {
    const body = await request.json();
    const { scope, content, source } = body;

    if (!scope || !String(scope).trim()) {
      return NextResponse.json({ error: "Scope is required" }, { status: 400 });
    }
    if (!content || !String(content).trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const memory = await rememberText(scope, String(content), { source: source || null });
    if (!memory) {
      return NextResponse.json({ error: "Failed to store memory" }, { status: 500 });
    }
    return NextResponse.json(memory, { status: 201 });
  } catch (error) {
    console.log("Error storing memory:", error);
    return NextResponse.json({ error: "Failed to store memory" }, { status: 500 });
  }
}

// DELETE /api/memory-fabric?id=123 - Forget one memory
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Memory id is required" }, { status: 400 });
    }
    const deleted = await forgetText(id);
    if (!deleted) {
      return NextResponse.json({ error: "Memory not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error deleting memory:", error);
    return NextResponse.json({ error: "Failed to delete memory" }, { status: 500 });
  }
}
