import { NextResponse } from "next/server";
import { getSettings, setSettings, claudeHome } from "@/lib/claudeStore";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    settings: getSettings(),
    dataDir: claudeHome(),
  });
}

export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  return NextResponse.json({ settings: setSettings(body) });
}
