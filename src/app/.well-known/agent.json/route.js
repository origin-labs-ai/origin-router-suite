import { NextResponse } from "next/server";
import { buildAgentCard } from "@/lib/a2a/index.js";

// The A2A Agent Card at the well-known location.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(buildAgentCard({ baseUrl: "" }));
}
