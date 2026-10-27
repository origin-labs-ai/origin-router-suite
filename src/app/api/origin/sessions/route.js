import { NextResponse } from "next/server";
import { listSessions, createSession } from "@/lib/claudeStore";

// Dashboard-authenticated: /api/* is deny-by-default in dashboardGuard.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ sessions: listSessions() });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to list sessions" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const session = createSession({
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : "New chat",
      model: typeof body.model === "string" ? body.model : "",
    });
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to create session" }, { status: 500 });
  }
}
